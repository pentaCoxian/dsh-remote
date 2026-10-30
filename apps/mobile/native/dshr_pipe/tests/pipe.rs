//! The pipe against in-process iroh hosts, relays off (no network needed).

use std::path::PathBuf;
use std::time::Duration;

use dshr_pipe::{parse_ticket, ticket_info, Pipes, ALPN, PUSH_ALPN, WEB_ALPN};
use iroh::endpoint::presets;
use iroh::{Endpoint, RelayMode, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

fn vector() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../../../protocol/vectors/pairing.json")).unwrap()
}

/// A host that answers each bi-stream by echoing it back upper-cased.
async fn echo_host() -> Endpoint {
    echo_host_with(SecretKey::generate()).await
}

async fn echo_host_with(secret_key: SecretKey) -> Endpoint {
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(secret_key)
        .alpns(vec![ALPN.to_vec(), WEB_ALPN.to_vec(), PUSH_ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .unwrap();
    let server = endpoint.clone();
    tokio::spawn(async move {
        while let Some(incoming) = server.accept().await {
            tokio::spawn(async move {
                let Ok(connection) = incoming.await else { return };
                // Web and push streams answer with a marker, so a test can tell which ALPN carried them.
                let marker: &[u8] = match connection.alpn() {
                    a if a == WEB_ALPN => b"web:",
                    a if a == PUSH_ALPN => b"push:",
                    _ => b"",
                };
                while let Ok((mut send, mut recv)) = connection.accept_bi().await {
                    tokio::spawn(async move {
                        let buf = recv.read_to_end(64 * 1024).await.unwrap();
                        send.write_all(marker).await.unwrap();
                        send.write_all(&buf.to_ascii_uppercase()).await.unwrap();
                        send.finish().unwrap();
                    });
                }
            });
        }
    });
    endpoint
}

fn socket_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("dshr-{}-{name}.sock", std::process::id()))
}

#[test]
fn decodes_the_protocol_ticket_vectors() {
    let v = vector();
    let info = ticket_info(v["ticket"]["full"].as_str().unwrap()).unwrap();
    assert_eq!(info["endpointId"], v["ticket"]["endpointId"]);
    assert_eq!(info["relayUrls"][0], v["ticket"]["relayUrl"]);
    assert_eq!(info["directAddresses"], v["ticket"]["directAddresses"]);
    let bare = parse_ticket(v["ticket"]["bare"].as_str().unwrap()).unwrap();
    assert_eq!(bare.id.to_string(), v["ticket"]["endpointId"].as_str().unwrap());
    assert!(parse_ticket("nodeabc").is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn carries_socket_connections_over_bi_streams() {
    let host = echo_host().await;
    let ticket = EndpointTicket::new(host.addr()).to_string();
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let path = socket_path("echo");
    let opened = pipes.open(&ticket, &path).await.unwrap();
    assert_eq!(opened["hostId"], host.id().to_string());

    // Two sockets at once: each gets its own stream.
    let mut handles = Vec::new();
    for text in ["first socket", "second socket"] {
        let path = path.clone();
        handles.push(tokio::spawn(async move {
            let mut socket = UnixStream::connect(&path).await.unwrap();
            socket.write_all(text.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
            let mut reply = String::new();
            socket.read_to_string(&mut reply).await.unwrap();
            reply
        }));
    }
    let replies: Vec<String> = futures_join(handles).await;
    assert_eq!(replies, vec!["FIRST SOCKET".to_string(), "SECOND SOCKET".to_string()]);

    let status = pipes.status(host.id()).await;
    assert_eq!(status["connected"], true);
    assert_eq!(status["remoteId"], host.id().to_string());
    assert!(status["paths"].as_array().unwrap().iter().any(|p| p["selected"] == true && p["relay"] == false));

    // The socket is private to the app.
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

    assert!(pipes.close(host.id()).await);
    assert!(!path.exists());
    pipes.shutdown().await;
    host.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_push_gateway_on_its_own_alpn() {
    let gateway = echo_host().await;
    let ticket = EndpointTicket::new(gateway.addr()).to_string();
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let path = socket_path("gateway");
    let opened = pipes.open_alpn(&ticket, &path, PUSH_ALPN).await.unwrap();
    assert_eq!(opened["hostId"], gateway.id().to_string());
    assert_eq!(round_trip(&path, "register").await, "push:REGISTER");
    // Opening it again only refreshes the address; the ALPN stays.
    pipes.open_alpn(&ticket, &path, PUSH_ALPN).await.unwrap();
    assert_eq!(round_trip(&path, "again").await, "push:AGAIN");
    assert!(pipes.close(gateway.id()).await);
    pipes.shutdown().await;
    gateway.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn follows_a_restarted_host_to_its_new_address() {
    let key = SecretKey::generate();
    let host = echo_host_with(key.clone()).await;
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let path = socket_path("restart");
    pipes.open(&EndpointTicket::new(host.addr()).to_string(), &path).await.unwrap();
    assert_eq!(round_trip(&path, "before").await, "BEFORE");

    // The host restarts: same key, new port. The connection is gone until the app
    // hands the pipe the fresh ticket (from /v1/host/address or a new QR).
    host.close().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(pipes.status(key.public()).await["connected"], false);
    let restarted = echo_host_with(key.clone()).await;
    pipes.open(&EndpointTicket::new(restarted.addr()).to_string(), &path).await.unwrap();
    assert_eq!(round_trip(&path, "after").await, "AFTER");

    pipes.shutdown().await;
    restarted.close().await;
}

/// A host killed (or its machine restarted) says nothing on the way out. The pipe
/// gives its connection up within the idle timeout instead of iroh's 30 s, during
/// which the connection looked open and DSH Web stood still on it.
#[tokio::test(flavor = "multi_thread")]
async fn gives_up_on_a_host_that_vanished() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let host = runtime.spawn(echo_host()).await.unwrap();
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let path = socket_path("vanish");
    pipes.open(&EndpointTicket::new(host.addr()).to_string(), &path).await.unwrap();
    assert_eq!(round_trip(&path, "before").await, "BEFORE");

    // Its tasks stop and its socket closes, with no CONNECTION_CLOSE sent.
    runtime.shutdown_background();
    let gone = std::time::Instant::now();
    while pipes.status(host.id()).await["connected"] == true {
        assert!(gone.elapsed() < Duration::from_secs(15), "still looks connected after {:?}", gone.elapsed());
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    pipes.shutdown().await;
    // Dropping it would reach for the runtime that is gone.
    std::mem::forget(host);
}

/// The web link's probe: answered through a host that serves its streams. A host
/// whose connection stays up (acknowledging, pinging) while no stream gets an
/// answer has the web connection hung up, so the next socket dials anew.
#[tokio::test(flavor = "multi_thread")]
async fn probes_the_web_link_and_hangs_up_a_stalled_one() {
    let host = echo_host().await;
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    pipes.open(&EndpointTicket::new(host.addr()).to_string(), &socket_path("probe")).await.unwrap();
    assert!(!pipes.probe_web(host.id()).await, "no tunnel yet");
    pipes.open_web(host.id(), 0).await.unwrap();
    assert!(pipes.probe_web(host.id()).await);
    pipes.shutdown().await;
    host.close().await;

    // Takes every connection and keeps it, but never takes a stream.
    let stalled = Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec(), WEB_ALPN.to_vec()]).relay_mode(RelayMode::Disabled).bind().await.unwrap();
    let kept = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let (server, held) = (stalled.clone(), kept.clone());
    tokio::spawn(async move {
        while let Some(incoming) = server.accept().await {
            if let Ok(connection) = incoming.await {
                held.lock().await.push(connection);
            }
        }
    });
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    pipes.open(&EndpointTicket::new(stalled.addr()).to_string(), &socket_path("stalled")).await.unwrap();
    pipes.open_web(stalled.id(), 0).await.unwrap();
    assert_eq!(pipes.status(stalled.id()).await["web"]["connected"], true);
    let started = std::time::Instant::now();
    assert!(!pipes.probe_web(stalled.id()).await);
    assert!(started.elapsed() >= Duration::from_secs(4), "waited for an answer first");
    assert_eq!(pipes.status(stalled.id()).await["web"]["connected"], false, "hung up");
    pipes.shutdown().await;
    stalled.close().await;
}

async fn round_trip(path: &std::path::Path, text: &str) -> String {
    let mut socket = UnixStream::connect(path).await.unwrap();
    socket.write_all(text.as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();
    let mut reply = String::new();
    socket.read_to_string(&mut reply).await.unwrap();
    reply
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_web_tunnel_on_a_loopback_port() {
    use tokio::net::TcpStream;
    let host = echo_host().await;
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    assert!(pipes.open_web(host.id(), 0).await.unwrap_err().contains("open the host first"));
    pipes.open(&EndpointTicket::new(host.addr()).to_string(), &socket_path("web")).await.unwrap();

    // The preferred port when it is free, so the WebView keeps one origin.
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let opened = pipes.open_web(host.id(), free).await.unwrap();
    assert_eq!(opened["port"], free);
    assert_eq!(pipes.open_web(host.id(), 1).await.unwrap()["port"], free, "reopening keeps the port");
    assert_eq!(pipes.status(host.id()).await["webPort"], free);

    let mut socket = TcpStream::connect(("127.0.0.1", free)).await.unwrap();
    socket.write_all(b"get /").await.unwrap();
    socket.shutdown().await.unwrap();
    let mut reply = String::new();
    socket.read_to_string(&mut reply).await.unwrap();
    assert_eq!(reply, "web:GET /");
    // The API socket still talks over the API ALPN.
    assert_eq!(round_trip(&socket_path("web"), "api").await, "API");

    assert!(pipes.close_web(host.id()).await);
    assert!(TcpStream::connect(("127.0.0.1", free)).await.is_err());
    assert_eq!(round_trip(&socket_path("web"), "still").await, "STILL");
    pipes.shutdown().await;
    host.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_the_web_link_on_its_own() {
    let host = echo_host().await;
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    pipes.open(&EndpointTicket::new(host.addr()).to_string(), &socket_path("weblink")).await.unwrap();
    assert_eq!(pipes.status(host.id()).await["web"], serde_json::Value::Null, "no tunnel yet");
    pipes.open_web(host.id(), 0).await.unwrap();
    assert_eq!(pipes.status(host.id()).await["web"]["connected"], true);

    // The host goes away: the app sees the web link down, and why.
    host.close().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let status = pipes.status(host.id()).await;
    assert_eq!(status["web"]["connected"], false);
    assert!(status["web"]["closed"].is_string(), "{status}");
    pipes.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_burst_of_sockets_to_a_host_that_is_down_shares_one_dial() {
    let host = echo_host().await;
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let path = socket_path("burst");
    pipes.open(&EndpointTicket::new(host.addr()).to_string(), &path).await.unwrap();
    host.close().await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // A WebView's reconnect burst: each socket would otherwise wait for its own dial.
    let started = std::time::Instant::now();
    let sockets: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            tokio::spawn(async move {
                let mut socket = UnixStream::connect(&path).await.unwrap();
                let mut reply = Vec::new();
                let _ = socket.read_to_end(&mut reply).await;
                reply.len()
            })
        })
        .collect();
    // The app's status checks do not wait on the dial.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let asked = std::time::Instant::now();
    let status = pipes.status(host.id()).await;
    assert!(asked.elapsed() < Duration::from_secs(1), "status waited {:?}", asked.elapsed());
    assert_eq!(status["dialing"], true);
    assert_eq!(futures_join(sockets).await, vec![0; 4], "each socket is dropped");
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(20), "the sockets dialed one after another: {elapsed:?}");
    pipes.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn suspends_without_a_new_endpoint_and_reopens() {
    use tokio::net::TcpStream;
    let host = echo_host().await;
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let id = pipes.endpoint_id();
    let path = socket_path("suspend");
    let ticket = EndpointTicket::new(host.addr()).to_string();
    pipes.open(&ticket, &path).await.unwrap();
    let port = pipes.open_web(host.id(), 0).await.unwrap()["port"].as_u64().unwrap() as u16;

    // The app in the background: sockets and connections go, the endpoint stays.
    pipes.suspend().await;
    assert!(!path.exists());
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    assert_eq!(pipes.status(host.id()).await["open"], false);

    // Back: the same endpoint opens the pipes again.
    pipes.open(&ticket, &path).await.unwrap();
    assert_eq!(pipes.endpoint_id(), id);
    assert_eq!(round_trip(&path, "back").await, "BACK");
    pipes.shutdown().await;
    host.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnects_a_host_on_a_new_connection() {
    let host = echo_host().await;
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let path = socket_path("reconnect");
    pipes.open(&EndpointTicket::new(host.addr()).to_string(), &path).await.unwrap();
    assert_eq!(round_trip(&path, "one").await, "ONE");
    assert!(pipes.reconnect(host.id()).await);
    assert_eq!(pipes.status(host.id()).await["connected"], false, "hung up");
    assert_eq!(round_trip(&path, "two").await, "TWO");
    assert!(!pipes.reconnect(SecretKey::generate().public()).await, "no such pipe");
    pipes.shutdown().await;
    host.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_fast_for_an_unreachable_host() {
    // A ticket naming a key nobody serves, with no addresses at all.
    let ticket = EndpointTicket::new(iroh::EndpointAddr::new(SecretKey::generate().public())).to_string();
    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let error = pipes.open(&ticket, &socket_path("nobody")).await.unwrap_err();
    assert!(error.contains("cannot reach the host") || error.contains("did not answer"), "{error}");
    assert!(!socket_path("nobody").exists());
    pipes.shutdown().await;
}

async fn futures_join<T>(handles: Vec<tokio::task::JoinHandle<T>>) -> Vec<T> {
    let mut out = Vec::new();
    for handle in handles {
        out.push(handle.await.unwrap());
    }
    out
}
