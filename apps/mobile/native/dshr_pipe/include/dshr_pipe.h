/*
 * dshr_pipe — DSH Remote phone transport (C ABI, see src/ffi.rs).
 *
 * Every function returns a heap JSON string, {"ok":true,...} or
 * {"ok":false,"error":"..."}, that the caller releases with dshr_string_free.
 * Calls block (dialing can take seconds): call them off the UI thread.
 */
#ifndef DSHR_PIPE_H
#define DSHR_PIPE_H

#include <stddef.h>
#include <stdint.h>

/* Start the endpoint: 32-byte iroh secret key, JSON array of relay URLs ([] = none). -> {endpointId} */
char *dshr_start(const uint8_t *secret_key, size_t secret_len, const char *relays_json);
/* Dial the host a ticket names and serve it on a Unix socket. -> {hostId, socketPath} */
char *dshr_open(const char *ticket, const char *socket_path);
/* The push gateway, served like a host on its own ALPN (dsh-remote/push/1). */
char *dshr_open_gateway(const char *ticket, const char *socket_path);
/* Stop serving a host (hex EndpointId). -> {closed} */
char *dshr_close(const char *host_id);
/* Serve the host's DSH Web tunnel on 127.0.0.1 (preferred_port when free). -> {port} */
char *dshr_open_web(const char *host_id, uint16_t preferred_port);
/* Stop the host's DSH Web tunnel. -> {closed} */
char *dshr_close_web(const char *host_id);
/* Connection details. -> {connected, remoteId?, paths:[{relay, selected, rttMs}], homeRelay, webPort, web} */
char *dshr_status(const char *host_id);
/* Hang up on a host and keep its pipe: the next socket dials anew. -> {reconnected} */
char *dshr_reconnect(const char *host_id);
/* Whether the DSH Web tunnel answers now; a stalled connection is hung up. -> {answered} */
char *dshr_probe_web(const char *host_id);
/* Parse a ticket without dialing. -> {endpointId, relayUrls, directAddresses} */
char *dshr_ticket_info(const char *ticket);
/* Tell iroh the network changed (Android). -> {} */
char *dshr_network_changed(void);
/* Close every pipe; the endpoint stays up (the app in the background). -> {} */
char *dshr_suspend(void);
/* Close every pipe and the endpoint. -> {} */
char *dshr_stop(void);
void dshr_string_free(char *text);

#endif
