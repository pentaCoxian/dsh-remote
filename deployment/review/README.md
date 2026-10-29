# App Review host

App Review needs a host to pair with, or DSH Remote shows nothing. This folder
builds one as a container:

- DSH 0.2.1-rc.3 with DSH Remote and dsh-mobile-maxxing from a release;
- a scripted model (`model.mjs`), so no API key or cost is involved;
- `start.mjs`, which serves a pairing page under a secret path and approves the
  phones that scan its codes (only those: codes from anywhere else still need
  the owner);
- Caddy in front for HTTPS (`compose.yml`).

**Whoever pairs gets DSH Web, terminal included, inside the container.** Run it
on a machine that holds nothing else (a small VM made for the review), keep the
page's path secret, and delete the machine after the review.

## Run it

On the VM (Docker with Compose), with a DNS name pointing at it and ports 80 and
443 open:

```sh
cd deployment/review
export REVIEW_DOMAIN=review.example.org
export REVIEW_TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')
docker compose up -d --build
echo "https://$REVIEW_DOMAIN/$REVIEW_TOKEN/"
```

The page shows a pairing code that renews itself, and how to try the app. The
container keeps its state (host key, paired phones) in the `home` volume, so a
restart does not unpair the reviewer. The image is x64 only: DSH ships one of
its native add-ons for no other Linux (an Apple silicon Mac runs it emulated).

To try it locally without HTTPS:

```sh
docker build -t dsh-remote-review deployment/review
docker run --rm -p 127.0.0.1:8080:8080 -e REVIEW_TOKEN=local-review-token-0001 dsh-remote-review
# http://127.0.0.1:8080/local-review-token-0001/
```

Paired phones: `docker compose exec review node .dsh/profiles/web/node_modules/@dsh-remote/dsh-plugin/dist/cli/main.js devices`.

## Review notes

For App Store Connect → App Review Information → Notes (no sign-in needed):

> DSH Remote is the phone app for DeepSeek Harness (DSH), a coding agent people
> run on their own computer. It has no accounts: the phone pairs with the user's
> own DSH host by scanning a code the host shows, then shows that host's DSH Web
> over an end-to-end encrypted connection, without exposing the host to the
> internet.
>
> We run a review host with a scripted model:
> 1. On a computer, open https://REVIEW_DOMAIN/REVIEW_TOKEN/ . It shows a
>    pairing code and renews it every minute.
> 2. On the iPhone, open DSH Remote, tap Connect host and scan the code (allow
>    the camera). The phone is approved automatically.
> 3. Tap "DSH Remote review host" to open DSH Web, and allow notifications.
> 4. Send any message for a reply. Send "please use a tool" to approve a tool
>    call. Send "notify me" and leave the app: an "Approval needed" notification
>    arrives about 45 seconds later.
>
> What the app does itself, beyond showing DSH Web: QR pairing with a key
> fingerprint check; every request signed with a Secure Enclave key; the
> encrypted QUIC tunnel (iroh) that carries DSH Web; and end-to-end encrypted
> notifications, decrypted on the device by a Notification Service Extension.
>
> Encryption: standard algorithms only (TLS 1.3 within QUIC, AES-GCM).
