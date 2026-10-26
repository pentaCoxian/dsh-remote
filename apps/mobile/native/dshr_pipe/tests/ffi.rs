//! The C ABI as Dart calls it: from plain threads, outside any Tokio runtime.
//! One test, because the ABI keeps one endpoint per process.

use std::ffi::{c_char, CStr, CString};
use std::time::Duration;

use dshr_pipe::ffi::{dshr_open, dshr_start, dshr_stop, dshr_string_free};
use dshr_pipe::ALPN;
use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, RelayMode, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use serde_json::Value;
use tokio::sync::mpsc;

fn reply(text: *mut c_char) -> Value {
    let value = serde_json::from_str(unsafe { CStr::from_ptr(text) }.to_str().unwrap()).unwrap();
    unsafe { dshr_string_free(text) };
    value
}

fn start() -> Value {
    let relays = CString::new("[]").unwrap();
    reply(unsafe { dshr_start([7u8; 32].as_ptr(), 32, relays.as_ptr()) })
}

fn open(ticket: &str, socket: &str) -> Value {
    let (ticket, socket) = (CString::new(ticket).unwrap(), CString::new(socket).unwrap());
    reply(unsafe { dshr_open(ticket.as_ptr(), socket.as_ptr()) })
}

/// The app going to the background and coming back: stop closes the host's
/// connection for real, and the transport starts and dials again.
#[test]
fn stops_and_starts_again() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (host, mut connections) = runtime.block_on(async {
        let host = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .unwrap();
        let (sender, receiver) = mpsc::unbounded_channel::<Connection>();
        let server = host.clone();
        tokio::spawn(async move {
            while let Some(incoming) = server.accept().await {
                if let Ok(connection) = incoming.await {
                    let _ = sender.send(connection);
                }
            }
        });
        (host, receiver)
    });
    let ticket = EndpointTicket::new(host.addr()).to_string();
    let socket = std::env::temp_dir().join(format!("dshr-{}-ffi.sock", std::process::id())).display().to_string();
    let next = |connections: &mut mpsc::UnboundedReceiver<Connection>| {
        runtime.block_on(async { tokio::time::timeout(Duration::from_secs(10), connections.recv()).await.expect("the host was dialed").unwrap() })
    };

    assert_eq!(start()["ok"], true);
    assert_eq!(open(&ticket, &socket)["ok"], true);
    let first = next(&mut connections);

    assert_eq!(reply(dshr_stop())["ok"], true);
    runtime.block_on(async { tokio::time::timeout(Duration::from_secs(5), first.closed()).await.expect("stop closed the host's connection") });

    assert_eq!(start()["ok"], true);
    assert_eq!(open(&ticket, &socket)["ok"], true);
    next(&mut connections);
    assert_eq!(reply(dshr_stop())["ok"], true);
}
