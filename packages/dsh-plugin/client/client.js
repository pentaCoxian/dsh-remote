// DSH Remote's DSH Web half, loaded by DSH Web as this package's client module
// (package.json `dsh.client`) and served as is: plain browser JavaScript.
//
// A bare `/rc` (typed, or picked from the command menu) opens a pairing dialog:
// a QR code for DSH Remote → Connect host, then the phone that scanned it with
// its key fingerprint and Approve / Deny. Everything comes live from the
// plugin's owner-only route (/api/dsh-remote/admin, behind DSH's own login);
// nothing is written to the session log. `/rc status` and the other arguments
// still run the host command.
window.__ModuleLoader__.load({
  id: '@dsh-remote/dsh-plugin',
  factory() {
    const ADMIN = '/api/dsh-remote/admin';
    const POLL_MS = 1000;

    async function admin(body) {
      const reply = await fetch(ADMIN, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-remote': '1' },
        body: JSON.stringify(body),
      });
      const json = await reply.json().catch(() => ({}));
      if (!reply.ok) throw new Error(json.error || `DSH Remote answered ${reply.status}`);
      return json;
    }

    const STYLE = `
.dsh-remote-scrim { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); padding: 16px; }
.dsh-remote-dialog { box-sizing: border-box; width: min(360px, 100%); max-height: 100%; overflow: auto; border-radius: 16px; padding: 20px;
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #0e0f11);
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08)); box-shadow: var(--dsw-shadow-lv2, 0 12px 40px rgba(0, 0, 0, 0.25));
  font: 14px/1.45 system-ui, -apple-system, sans-serif; }
.dsh-remote-dialog h2 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
.dsh-remote-dialog p { margin: 0 0 12px; color: var(--dsw-alias-label-secondary, #656b75); }
.dsh-remote-qr { background: #fff; border-radius: 12px; padding: 12px; margin: 4px 0 10px; }
.dsh-remote-qr svg { display: block; width: 100%; height: auto; }
.dsh-remote-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary, #9da3ad); margin-bottom: 14px; }
.dsh-remote-phone { border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.1)); border-radius: 12px; padding: 12px; margin-bottom: 14px; }
.dsh-remote-phone div { margin: 2px 0; }
.dsh-remote-fingerprint { font: 600 15px/1.4 ui-monospace, Menlo, monospace; letter-spacing: 0.5px; }
.dsh-remote-error { color: #e5484d; margin-bottom: 12px; }
.dsh-remote-actions { display: flex; gap: 8px; justify-content: flex-end; }
.dsh-remote-actions button { font: inherit; font-weight: 500; border-radius: 10px; padding: 8px 14px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)); background: transparent; color: inherit; }
.dsh-remote-actions button.primary { background: var(--dsw-alias-label-primary, #0e0f11); color: var(--dsw-alias-bg-layer-2, #fff); border-color: transparent; }
`;

    function ensureStyle() {
      if (document.getElementById('dsh-remote-style')) return;
      const style = document.createElement('style');
      style.id = 'dsh-remote-style';
      style.textContent = STYLE;
      document.head.append(style);
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function button(label, primary, onClick) {
      const node = el('button', primary ? 'primary' : '', label);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    }

    let open = null;

    function openPairing() {
      if (open !== null) return;
      ensureStyle();
      const scrim = el('div', 'dsh-remote-scrim');
      const dialog = el('div', 'dsh-remote-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', 'Pair a phone with DSH Remote');
      scrim.append(dialog);
      document.body.append(scrim);

      let timer = 0;
      let offer = null;
      let decided = false;
      const close = () => {
        clearInterval(timer);
        scrim.remove();
        document.removeEventListener('keydown', onKey, true);
        open = null;
      };
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      };
      document.addEventListener('keydown', onKey, true);
      scrim.addEventListener('click', (event) => {
        if (event.target === scrim) close();
      });
      open = { close };

      const render = (...children) => dialog.replaceChildren(...children);
      const fail = (error) => {
        clearInterval(timer);
        render(el('h2', '', 'Pair a phone'), el('div', 'dsh-remote-error', error instanceof Error ? error.message : String(error)), actions(button('Try again', true, start), button('Close', false, close)));
      };
      const actions = (...buttons) => {
        const row = el('div', 'dsh-remote-actions');
        row.append(...buttons);
        return row;
      };

      async function start() {
        clearInterval(timer);
        decided = false;
        render(el('h2', '', 'Pair a phone'), el('p', '', 'Getting a code…'));
        try {
          offer = await admin({ method: 'offerPairing' });
        } catch (error) {
          return fail(error);
        }
        dialog.dataset.pairingUrl = offer.url;
        const qr = el('div', 'dsh-remote-qr');
        qr.innerHTML = offer.qrSvg; // made by the plugin from its own pairing URL
        const meta = el('div', 'dsh-remote-meta');
        render(
          el('h2', '', 'Pair a phone'),
          el('p', '', 'In DSH Remote, tap Connect host and scan this code.'),
          qr,
          meta,
          actions(button('Close', false, close)),
        );
        const tick = async () => {
          const left = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000));
          meta.textContent = left > 0 ? `Host ${offer.hostId.slice(0, 10)} · code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'This code expired.';
          if (left === 0) {
            clearInterval(timer);
            render(el('h2', '', 'Pair a phone'), el('p', '', 'The code expired before a phone used it.'), actions(button('New code', true, start), button('Close', false, close)));
            return;
          }
          try {
            const pending = await admin({ method: 'pendingPairings' });
            const request = pending.find((candidate) => candidate.challengeId === offer.challengeId);
            if (request !== undefined && !decided) {
              clearInterval(timer);
              showRequest(request);
            }
          } catch (error) {
            fail(error);
          }
        };
        timer = setInterval(tick, POLL_MS);
        void tick();
      }

      function showRequest(request) {
        const phone = el('div', 'dsh-remote-phone');
        phone.append(
          el('div', '', `${request.deviceLabel} · ${request.platform}${request.hardwareBacked ? ' · hardware key' : ' · software key'}`),
          el('div', 'dsh-remote-meta', 'Key fingerprint, as the phone shows it:'),
          el('div', 'dsh-remote-fingerprint', request.shortFingerprint),
        );
        const decide = (decision) => async () => {
          decided = true;
          try {
            await admin({ method: 'decidePairing', pairingRequestId: request.pairingRequestId, decision });
          } catch (error) {
            return fail(error);
          }
          render(
            el('h2', '', decision === 'approve' ? 'Phone paired' : 'Not paired'),
            el('p', '', decision === 'approve' ? `${request.deviceLabel} can now open DSH Web from DSH Remote.` : `${request.deviceLabel} was refused.`),
            actions(button('Done', true, close)),
          );
        };
        render(
          el('h2', '', 'Approve this phone?'),
          el('p', '', 'Approve only if the fingerprint matches the one on the phone. A paired phone gets full DSH Web access.'),
          phone,
          actions(button('Deny', false, decide('deny')), button('Approve', true, decide('approve'))),
        );
      }

      void start();
    }

    return {
      inject: [],
      apply(ctx) {
        // The command service arrives on its own schedule, like the rest of DSH Web's UI.
        ctx.inject(['commandUi'], (scope) => {
          const commandUi = scope.get('commandUi');
          if (commandUi === null || commandUi === undefined) return;
          const disposers = ['rc', 'remote-control'].map((name) => commandUi.decorate({ name, available: () => true, ui: { kind: 'action', run: () => openPairing() } }));
          return () => {
            for (const dispose of disposers) dispose();
            open?.close();
          };
        });
      },
    };
  },
});
