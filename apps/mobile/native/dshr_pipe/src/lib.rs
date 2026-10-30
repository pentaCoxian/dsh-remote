//! DSH Remote's phone transport, called from Dart through the C ABI in `ffi`.
//!
//! One iroh endpoint per app process and one *pipe* per paired host. A pipe
//! dials the host's ticket, so QUIC authenticates the host's EndpointId and no
//! relay or network can stand in for it. It then serves that connection on a
//! Unix socket inside the app sandbox: each accepted socket connection becomes
//! one QUIC bi-stream, which the host plugin serves as one HTTP/1.1
//! connection. The app's ordinary HTTP and WebSocket clients run over it
//! unchanged.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use iroh::endpoint::{presets, Connection, QuicTransportConfig};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::Mutex;
use tokio::task::{JoinHandle, JoinSet};

pub mod ffi;

/// ALPN of the DSH Remote API over iroh (the host plugin's `ALPN`).
pub const ALPN: &[u8] = b"dsh-remote/1";
/// ALPN of the DSH Web tunnel: each bi-stream is one connection to DSH Web on the host.
pub const WEB_ALPN: &[u8] = b"dsh-remote/web/1";
/// ALPN of the push gateway, which the app reaches like a host: HTTP/1.1 per bi-stream.
pub const PUSH_ALPN: &[u8] = b"dsh-remote/push/1";
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
/// A dial that failed this recently fails the sockets queued behind it too, so a
/// WebView's burst of connections to a host that is down does not dial it once each.
const DIAL_FAILURE_HOLD: Duration = Duration::from_secs(2);
/// How long a socket waits for a stream: a connection with none to spare is as good as down.
const STREAM_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the host may keep answering after the app closed its side of a socket.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
/// A connection that has heard nothing from the host for this long is closed, so the
/// next socket dials a new one. iroh's own 30 s kept a dead connection (a restarted
/// host, a path the network dropped) looking open while DSH Web stood still on it.
const IDLE_TIMEOUT: Duration = Duration::from_secs(10);

pub type Result<T> = std::result::Result<T, String>;

/// Parse a ticket into the address it names.
pub fn parse_ticket(ticket: &str) -> Result<EndpointAddr> {
    ticket.trim().parse::<EndpointTicket>().map(EndpointAddr::from).map_err(|e| format!("not a host ticket: {e}"))
}

/// What a ticket says, for the pairing confirm screen.
pub fn ticket_info(ticket: &str) -> Result<Value> {
    let addr = parse_ticket(ticket)?;
    Ok(json!({
        "endpointId": addr.id.to_string(),
        "relayUrls": addr.relay_urls().map(|url| url.to_string()).collect::<Vec<_>>(),
        "directAddresses": addr.ip_addrs().map(|ip| ip.to_string()).collect::<Vec<_>>(),
    }))
}

/// The endpoint and its pipes. Dropping it does not close anything: call `shutdown`.
pub struct Pipes {
    endpoint: Endpoint,
    /// This phone's relays, also tried for every host (see [`Link::connection`]).
    relays: Vec<RelayUrl>,
    pipes: Mutex<HashMap<EndpointId, Pipe>>,
}

struct Pipe {
    link: Arc<Link>,
    socket_path: PathBuf,
    accept: JoinHandle<()>,
    web: Option<WebPipe>,
}

/// The DSH Web tunnel for one host: a loopback TCP port for the app's WebView.
struct WebPipe {
    link: Arc<Link>,
    port: u16,
    accept: JoinHandle<()>,
}

/// One host on one ALPN: where to dial it and the connection while it lasts.
struct Link {
    endpoint: Endpoint,
    alpn: &'static [u8],
    addr: std::sync::Mutex<EndpointAddr>,
    relays: Vec<RelayUrl>,
    /// Held while dialing, so concurrent sockets share one dial.
    connection: Mutex<Dialed>,
}

#[derive(Default)]
struct Dialed {
    connection: Option<Connection>,
    failure: Option<(Instant, String)>,
}

impl Link {
    fn new(endpoint: Endpoint, alpn: &'static [u8], addr: EndpointAddr, relays: Vec<RelayUrl>) -> Self {
        Self { endpoint, alpn, addr: std::sync::Mutex::new(addr), relays, connection: Mutex::new(Dialed::default()) }
    }

    /// The live connection, redialed once the last one has closed.
    async fn connection(&self) -> Result<Connection> {
        let mut current = self.connection.lock().await;
        if let Some(connection) = current.connection.as_ref()
            && connection.close_reason().is_none()
        {
            return Ok(connection.clone());
        }
        if let Some((at, error)) = &current.failure
            && at.elapsed() < DIAL_FAILURE_HOLD
        {
            return Err(error.clone());
        }
        // The ticket names the host's home relay when it was written. A restarted host
        // may have homed on another of the same relays (or its old one may be down),
        // and only a connection could fetch its new ticket: look on all of them.
        let addr = self.relays.iter().cloned().fold(self.addr.lock().expect("addr lock").clone(), EndpointAddr::with_relay_url);
        let dialed = match tokio::time::timeout(DIAL_TIMEOUT, self.endpoint.connect(addr, self.alpn)).await {
            Err(_) => Err("the host did not answer".to_string()),
            Ok(Err(e)) => Err(format!("cannot reach the host: {e}")),
            Ok(Ok(connection)) => Ok(connection),
        };
        match dialed {
            Ok(connection) => {
                *current = Dialed { connection: Some(connection.clone()), failure: None };
                Ok(connection)
            }
            Err(error) => {
                current.failure = Some((Instant::now(), error.clone()));
                Err(error)
            }
        }
    }

    /// Take the connection, to close it.
    async fn take(&self) -> Option<Connection> {
        self.connection.lock().await.connection.take()
    }

    /// Never waits on a dial in progress: it reports `dialing` instead.
    fn status(&self) -> Value {
        let Ok(current) = self.connection.try_lock() else {
            return json!({ "connected": false, "dialing": true, "paths": [] });
        };
        let Some(connection) = current.connection.as_ref().filter(|c| c.close_reason().is_none()) else {
            let closed = current.connection.as_ref().and_then(|c| c.close_reason()).map(|reason| reason.to_string());
            return json!({ "connected": false, "paths": [], "closed": closed.or_else(|| current.failure.as_ref().map(|(_, error)| error.clone())) });
        };
        let paths: Vec<Value> = connection
            .paths()
            .iter()
            .map(|path| json!({ "relay": path.is_relay(), "selected": path.is_selected(), "rttMs": path.rtt().as_millis() as u64 }))
            .collect();
        json!({ "connected": true, "remoteId": connection.remote_id().to_string(), "paths": paths })
    }
}

impl Pipes {
    /// Bind the phone's endpoint. `relays` empty disables relays (LAN and direct only).
    pub async fn start(secret_key: [u8; 32], relays: &[String]) -> Result<Self> {
        let relays = relays.iter().map(|url| url.parse::<RelayUrl>().map_err(|e| format!("bad relay url {url}: {e}"))).collect::<Result<Vec<_>>>()?;
        let relay_mode = if relays.is_empty() { RelayMode::Disabled } else { RelayMode::Custom(RelayMap::from_iter(relays.clone())) };
        // iroh pings an idle connection every 5 s, so one that hears nothing for IDLE_TIMEOUT is dead.
        let transport = QuicTransportConfig::builder().max_idle_timeout(Some(IDLE_TIMEOUT.try_into().expect("idle timeout fits a VarInt"))).build();
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::from_bytes(&secret_key))
            .relay_mode(relay_mode)
            .transport_config(transport)
            .bind()
            .await
            .map_err(|e| format!("cannot start the iroh endpoint: {e}"))?;
        Ok(Self { endpoint, relays, pipes: Mutex::new(HashMap::new()) })
    }

    fn link(&self, alpn: &'static [u8], addr: EndpointAddr) -> Arc<Link> {
        Arc::new(Link::new(self.endpoint.clone(), alpn, addr, self.relays.clone()))
    }

    pub fn endpoint_id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// Serve the host `ticket` names on `socket_path`, dialing it first so an
    /// unreachable host fails here. Opening a host that already has a pipe only
    /// refreshes its address (e.g. a newer ticket from `/v1/host/address`).
    pub async fn open(&self, ticket: &str, socket_path: &Path) -> Result<Value> {
        self.open_alpn(ticket, socket_path, ALPN).await
    }

    /// `open` for another kind of peer: the push gateway speaks `PUSH_ALPN`.
    pub async fn open_alpn(&self, ticket: &str, socket_path: &Path, alpn: &'static [u8]) -> Result<Value> {
        let addr = parse_ticket(ticket)?;
        let host = addr.id;
        // Dials happen outside the lock: a host that is down must not stall status calls.
        let existing = self.pipes.lock().await.get(&host).map(|pipe| {
            *pipe.link.addr.lock().expect("addr lock") = addr.clone();
            if let Some(web) = &pipe.web {
                *web.link.addr.lock().expect("addr lock") = addr.clone();
            }
            (pipe.link.clone(), pipe.socket_path.clone())
        });
        if let Some((link, socket_path)) = existing {
            link.connection().await?;
            return Ok(json!({ "hostId": host.to_string(), "socketPath": socket_path }));
        }
        let link = self.link(alpn, addr);
        link.connection().await?;
        let mut pipes = self.pipes.lock().await;
        if let Some(pipe) = pipes.get(&host) {
            // Opened meanwhile by another call: keep that one.
            if let Some(connection) = link.take().await {
                connection.close(0u32.into(), b"duplicate");
            }
            return Ok(json!({ "hostId": host.to_string(), "socketPath": pipe.socket_path }));
        }
        let _ = tokio::fs::remove_file(socket_path).await;
        let listener = UnixListener::bind(socket_path).map_err(|e| format!("cannot listen on {}: {e}", socket_path.display()))?;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("cannot restrict the socket: {e}"))?;
        let accept = tokio::spawn(serve(listener, link.clone()));
        pipes.insert(host, Pipe { link, socket_path: socket_path.to_path_buf(), accept, web: None });
        Ok(json!({ "hostId": host.to_string(), "socketPath": socket_path }))
    }

    /// Serve the host's DSH Web tunnel on a 127.0.0.1 TCP port for the WebView,
    /// `preferred_port` when free (a stable origin keeps DSH Web's browser
    /// storage), else any. The host must have an open pipe, and must have
    /// opened this phone's web window (`POST /v1/web/session`) first. Other apps
    /// on the phone can reach the port but not DSH Web: DSH still wants its
    /// owner cookie, which only this app's WebView holds.
    pub async fn open_web(&self, host: EndpointId, preferred_port: u16) -> Result<Value> {
        let (existing, addr) = {
            let pipes = self.pipes.lock().await;
            let pipe = pipes.get(&host).ok_or_else(|| "open the host first".to_string())?;
            (pipe.web.as_ref().map(|web| (web.link.clone(), web.port)), pipe.link.addr.lock().expect("addr lock").clone())
        };
        if let Some((link, port)) = existing {
            link.connection().await?;
            return Ok(json!({ "port": port }));
        }
        let link = self.link(WEB_ALPN, addr);
        link.connection().await?;
        let mut pipes = self.pipes.lock().await;
        let Some(pipe) = pipes.get_mut(&host) else {
            if let Some(connection) = link.take().await {
                connection.close(0u32.into(), b"closed by app");
            }
            return Err("the host was closed".into());
        };
        if let Some(web) = &pipe.web {
            if let Some(connection) = link.take().await {
                connection.close(0u32.into(), b"duplicate");
            }
            return Ok(json!({ "port": web.port }));
        }
        let listener = match TcpListener::bind(("127.0.0.1", preferred_port)).await {
            Ok(listener) => listener,
            Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("cannot listen for the web view: {e}"))?,
        };
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let accept = tokio::spawn(serve_tcp(listener, link.clone()));
        pipe.web = Some(WebPipe { link, port, accept });
        Ok(json!({ "port": port }))
    }

    /// Stop the host's DSH Web tunnel; the API pipe stays.
    pub async fn close_web(&self, host: EndpointId) -> bool {
        let web = self.pipes.lock().await.get_mut(&host).and_then(|pipe| pipe.web.take());
        let Some(web) = web else { return false };
        stop_web(web).await;
        true
    }

    /// Stop serving `host` and hang up.
    pub async fn close(&self, host: EndpointId) -> bool {
        let Some(pipe) = self.pipes.lock().await.remove(&host) else { return false };
        stop_pipe(pipe).await;
        true
    }

    pub async fn status(&self, host: EndpointId) -> Value {
        let pipes = self.pipes.lock().await;
        let mut status = match pipes.get(&host) {
            Some(pipe) => {
                // DSH Web runs over the web link, which may be the only live one.
                let mut status = pipe.link.status();
                let web = pipe.web.as_ref().map(|web| web.link.status());
                if status["connected"] != true
                    && let Some(web) = &web
                    && web["connected"] == true
                {
                    status = web.clone();
                }
                status["webPort"] = json!(pipe.web.as_ref().map(|web| web.port));
                // The web link on its own: DSH Web needs that one, whatever the API link does.
                status["web"] = web.unwrap_or(Value::Null);
                status
            }
            None => json!({ "connected": false, "paths": [], "open": false }),
        };
        status["homeRelay"] = json!(self.endpoint.addr().relay_urls().next().map(|url| url.to_string()));
        status
    }

    /// Tell iroh the network changed (Android does not let native code see it).
    pub async fn network_changed(&self) {
        self.endpoint.network_change().await;
    }

    /// Hang up on `host` and keep its pipe: the next socket dials a new
    /// connection. For a connection that still looks open but carries nothing.
    pub async fn reconnect(&self, host: EndpointId) -> bool {
        let links: Vec<Arc<Link>> = match self.pipes.lock().await.get(&host) {
            Some(pipe) => std::iter::once(pipe.link.clone()).chain(pipe.web.as_ref().map(|web| web.link.clone())).collect(),
            None => return false,
        };
        for link in links {
            if let Some(connection) = link.take().await {
                connection.close(0u32.into(), b"reconnecting");
            }
        }
        true
    }

    /// Close every pipe and remove the sockets; the endpoint stays up. The app
    /// does this in the background rather than stopping the endpoint: a new
    /// endpoint started while the old one is still closing would share its key,
    /// and the two would take turns on the relay, stalling the new connections.
    pub async fn suspend(&self) {
        let pipes: Vec<Pipe> = self.pipes.lock().await.drain().map(|(_, pipe)| pipe).collect();
        for pipe in pipes {
            stop_pipe(pipe).await;
        }
    }

    /// Close every pipe, remove the sockets and close the endpoint.
    pub async fn shutdown(&self) {
        self.suspend().await;
        self.endpoint.close().await;
    }
}

async fn stop_pipe(mut pipe: Pipe) {
    if let Some(web) = pipe.web.take() {
        stop_web(web).await;
    }
    pipe.accept.abort();
    if let Some(connection) = pipe.link.take().await {
        connection.close(0u32.into(), b"closed by app");
    }
    let _ = tokio::fs::remove_file(&pipe.socket_path).await;
}

async fn stop_web(web: WebPipe) {
    web.accept.abort();
    if let Some(connection) = web.link.take().await {
        connection.close(0u32.into(), b"closed by app");
    }
}

// The bridges live in the accept loop's JoinSet, so stopping a pipe (aborting the
// loop) ends its sockets too, and nothing keeps its link and endpoint alive after it.
async fn serve(listener: UnixListener, link: Arc<Link>) {
    let mut bridges = JoinSet::new();
    while let Ok((socket, _)) = listener.accept().await {
        while bridges.try_join_next().is_some() {}
        let link = link.clone();
        bridges.spawn(async move {
            // A host that cannot be reached drops the socket: the app sees it as offline.
            let (from_app, to_app) = socket.into_split();
            let _ = bridge(from_app, to_app, &link).await;
        });
    }
}

async fn serve_tcp(listener: TcpListener, link: Arc<Link>) {
    let mut bridges = JoinSet::new();
    while let Ok((socket, _)) = listener.accept().await {
        while bridges.try_join_next().is_some() {}
        let _ = socket.set_nodelay(true);
        let link = link.clone();
        bridges.spawn(async move {
            let (from_app, to_app) = socket.into_split();
            let _ = bridge(from_app, to_app, &link).await;
        });
    }
}

/// Copy one app-side connection over one bi-stream, both ways, until both sides end.
async fn bridge<R, W>(mut from_app: R, mut to_app: W, link: &Link) -> Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let connection = link.connection().await?;
    let (mut send, mut recv) = tokio::time::timeout(STREAM_TIMEOUT, connection.open_bi())
        .await
        .map_err(|_| "no stream to spare".to_string())?
        .map_err(|e| format!("cannot open a stream: {e}"))?;
    let mut down = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut recv, &mut to_app).await;
        let _ = to_app.shutdown().await;
    });
    let _ = tokio::io::copy(&mut from_app, &mut send).await;
    let _ = send.finish();
    if tokio::time::timeout(DRAIN_TIMEOUT, &mut down).await.is_err() {
        down.abort();
    }
    Ok(())
}
