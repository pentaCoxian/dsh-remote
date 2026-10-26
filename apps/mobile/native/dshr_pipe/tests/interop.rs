//! The pipe against the real host plugin (Node): ticket from its pairing QR,
//! HTTP over the app-side Unix socket, answered by the plugin's native API.
//! Opt-in, since it needs Node 24:
//!   DSHR_INTEROP_NODE=$(which node) cargo test --test interop

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use dshr_pipe::Pipes;
use iroh::SecretKey;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

async fn http(path: &std::path::Path, request: &str) -> String {
    let mut socket = UnixStream::connect(path).await.unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut reply = String::new();
    socket.read_to_string(&mut reply).await.unwrap();
    reply
}

#[tokio::test(flavor = "multi_thread")]
async fn talks_to_the_host_plugin() {
    let Ok(node) = std::env::var("DSHR_INTEROP_NODE") else {
        eprintln!("skipped: set DSHR_INTEROP_NODE to a Node 24 binary");
        return;
    };
    let plugin = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/dsh-plugin");
    let mut host = Command::new(node)
        .args(["--conditions=source", "test/fixtures/iroh-host.ts"])
        .current_dir(plugin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start the host fixture");
    let mut line = String::new();
    BufReader::new(host.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let fixture: serde_json::Value = serde_json::from_str(&line).expect("fixture JSON");
    let url = url_query(fixture["url"].as_str().unwrap());
    assert_eq!(url["n"], "Home Lab");

    let pipes = Pipes::start(SecretKey::generate().to_bytes(), &[]).await.unwrap();
    let path = std::env::temp_dir().join(format!("dshr-interop-{}.sock", std::process::id()));
    let opened = pipes.open(&url["t"], &path).await.unwrap();
    assert_eq!(opened["hostId"], fixture["hostId"]);

    // Unsigned, so the plugin refuses, but it is the plugin answering: its
    // request id and error envelope came back through QUIC and the socket.
    let meta = http(&path, "GET /v1/meta HTTP/1.1\r\nhost: dsh\r\nconnection: close\r\n\r\n").await;
    assert!(meta.starts_with("HTTP/1.1 426"), "{meta}");
    assert!(meta.contains("x-dsh-request-id: trace_"), "{meta}");
    assert!(meta.contains("\"PROTOCOL_UNSUPPORTED\""), "{meta}");

    // A WebSocket upgrade travels the same way and is refused before upgrading.
    let upgrade = http(&path, "GET /v1/events HTTP/1.1\r\nhost: dsh\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").await;
    assert!(upgrade.starts_with("HTTP/1.1 426"), "{upgrade}");

    pipes.shutdown().await;
    drop(host.stdin.take());
    host.wait().unwrap();
}

/// The query of a `dshremote://pair?…` URL (the QR text), percent-decoded.
fn url_query(url: &str) -> std::collections::HashMap<String, String> {
    let query = url.split_once('?').unwrap().1;
    query
        .split('&')
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap();
            (key.to_string(), percent_decode(value))
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.replace('+', " ").into_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap(), 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}
