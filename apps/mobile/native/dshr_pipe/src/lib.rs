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
use std::time::Duration;

use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub mod ffi;

/// ALPN of the DSH Remote API over iroh (the host plugin's `ALPN`).
pub const ALPN: &[u8] = b"dsh-remote/1";
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the host may keep answering after the app closed its side of a socket.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

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
    pipes: Mutex<HashMap<EndpointId, Pipe>>,
}

struct Pipe {
    link: Arc<Link>,
    socket_path: PathBuf,
    accept: JoinHandle<()>,
}

/// One host: where to dial it and the connection while it lasts.
struct Link {
    endpoint: Endpoint,
    addr: std::sync::Mutex<EndpointAddr>,
    connection: Mutex<Option<Connection>>,
}

impl Link {
    /// The live connection, redialed once the last one has closed.
    async fn connection(&self) -> Result<Connection> {
        let mut current = self.connection.lock().await;
        if let Some(connection) = current.as_ref()
            && connection.close_reason().is_none()
        {
            return Ok(connection.clone());
        }
        let addr = self.addr.lock().expect("addr lock").clone();
        let connection = tokio::time::timeout(DIAL_TIMEOUT, self.endpoint.connect(addr, ALPN))
            .await
            .map_err(|_| "the host did not answer".to_string())?
            .map_err(|e| format!("cannot reach the host: {e}"))?;
        *current = Some(connection.clone());
        Ok(connection)
    }

    async fn status(&self) -> Value {
        let current = self.connection.lock().await;
        let Some(connection) = current.as_ref().filter(|c| c.close_reason().is_none()) else {
            return json!({ "connected": false, "paths": [] });
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
        let relay_mode = if relays.is_empty() {
            RelayMode::Disabled
        } else {
            let urls = relays.iter().map(|url| url.parse::<RelayUrl>().map_err(|e| format!("bad relay url {url}: {e}"))).collect::<Result<Vec<_>>>()?;
            RelayMode::Custom(RelayMap::from_iter(urls))
        };
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::from_bytes(&secret_key))
            .relay_mode(relay_mode)
            .bind()
            .await
            .map_err(|e| format!("cannot start the iroh endpoint: {e}"))?;
        Ok(Self { endpoint, pipes: Mutex::new(HashMap::new()) })
    }

    pub fn endpoint_id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// Serve the host `ticket` names on `socket_path`, dialing it first so an
    /// unreachable host fails here. Opening a host that already has a pipe only
    /// refreshes its address (e.g. a newer ticket from `/v1/host/address`).
    pub async fn open(&self, ticket: &str, socket_path: &Path) -> Result<Value> {
        let addr = parse_ticket(ticket)?;
        let host = addr.id;
        let mut pipes = self.pipes.lock().await;
        if let Some(pipe) = pipes.get(&host) {
            *pipe.link.addr.lock().expect("addr lock") = addr;
            pipe.link.connection().await?;
            return Ok(json!({ "hostId": host.to_string(), "socketPath": pipe.socket_path }));
        }
        let link = Arc::new(Link { endpoint: self.endpoint.clone(), addr: std::sync::Mutex::new(addr), connection: Mutex::new(None) });
        link.connection().await?;
        let _ = tokio::fs::remove_file(socket_path).await;
        let listener = UnixListener::bind(socket_path).map_err(|e| format!("cannot listen on {}: {e}", socket_path.display()))?;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("cannot restrict the socket: {e}"))?;
        let accept = tokio::spawn(serve(listener, link.clone()));
        pipes.insert(host, Pipe { link, socket_path: socket_path.to_path_buf(), accept });
        Ok(json!({ "hostId": host.to_string(), "socketPath": socket_path }))
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
            Some(pipe) => pipe.link.status().await,
            None => json!({ "connected": false, "paths": [], "open": false }),
        };
        status["homeRelay"] = json!(self.endpoint.addr().relay_urls().next().map(|url| url.to_string()));
        status
    }

    /// Tell iroh the network changed (Android does not let native code see it).
    pub async fn network_changed(&self) {
        self.endpoint.network_change().await;
    }

    /// Close every pipe, remove the sockets and close the endpoint.
    pub async fn shutdown(&self) {
        let pipes: Vec<Pipe> = self.pipes.lock().await.drain().map(|(_, pipe)| pipe).collect();
        for pipe in pipes {
            stop_pipe(pipe).await;
        }
        self.endpoint.close().await;
    }
}

async fn stop_pipe(pipe: Pipe) {
    pipe.accept.abort();
    if let Some(connection) = pipe.link.connection.lock().await.take() {
        connection.close(0u32.into(), b"closed by app");
    }
    let _ = tokio::fs::remove_file(&pipe.socket_path).await;
}

async fn serve(listener: UnixListener, link: Arc<Link>) {
    while let Ok((socket, _)) = listener.accept().await {
        let link = link.clone();
        tokio::spawn(async move {
            // A host that cannot be reached drops the socket: the app sees it as offline.
            let _ = bridge(socket, &link).await;
        });
    }
}

/// Copy one socket connection over one bi-stream, both ways, until both sides end.
async fn bridge(socket: UnixStream, link: &Link) -> Result<()> {
    let connection = link.connection().await?;
    let (mut send, mut recv) = connection.open_bi().await.map_err(|e| format!("cannot open a stream: {e}"))?;
    let (mut from_app, mut to_app) = socket.into_split();
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
