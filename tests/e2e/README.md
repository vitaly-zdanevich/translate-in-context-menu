# Firefox browser tests

These tests install a temporary copy of the extension in a fresh Firefox profile,
serve a local fixture page, select text, and perform real right mouse clicks. They
check that the native menu updates while open, shows the translation without an
`RU:` prefix, and remains enabled during loading and errors. They also cover late
responses, empty selections, and waking the suspended MV3 background page.

The tests open Firefox's Add-ons Manager to exercise its native embedded
preferences: save, reload, and remove a fake API key. A request counter verifies
that missing-key handling and preference changes do not call the translation API.
Clicking the menu checks the Google Translate URL and selected text; the browser
navigation is intercepted before it reaches the external website.

Phone checks use the production Node HTTP relay, real SSE connections, and the
phone page in a desktop Firefox tab. They exercise Firefox's registered
**Alt+Shift+T** command over loopback and a private LAN address. The LAN check is
skipped when no private IPv4 interface is available. Physical shortcut capture and
an actual Firefox Android device still require manual testing.

Requirements: Python 3.10+, Node.js 24+, Firefox 156+, and a graphical display. On
Linux without a display, install Xvfb and run from the project root:

```sh
xvfb-run -a python3 tests/e2e/firefox.py
```

With an existing graphical display:

```sh
python3 tests/e2e/firefox.py
```

Set `FIREFOX_BIN` to use a Firefox executable outside `PATH`. The tests need local
socket access for Firefox automation, the fixture server, and the phone relay.
No npm or Python packages, geckodriver, Google account, or API key are required.

The [GitHub Actions workflow](../../.github/workflows/tests.yml) runs these checks
on Ubuntu with Node.js 24, the latest stable Firefox, and Xvfb. Python and Xvfb
come from the hosted runner; `FIREFOX_BIN` points to the browser installed by CI.

The temporary extension copy imports [the fetch fixture](../fixtures/google-translate.js)
before loading the production background module. It validates the official Google
Cloud Translation Basic POST URL, JSON body, and API-key header, then returns
deterministic responses without contacting Google. Only Google translation fetches
are mocked; relay requests use the real local server. Only `test-api-key` is used.
The source extension remains unchanged. These tests do not verify Google's
service availability.

Firefox's [Marionette protocol](https://firefox-source-docs.mozilla.org/remote/marionette/Protocol.html)
provides native browser UI automation. The small standard-library client uses its
documented length-prefixed JSON protocol and
[privileged browser access](https://firefox-source-docs.mozilla.org/testing/geckodriver/Flags.html#allow-system-access)
only in the isolated test profile. The profile and copied extension are removed
after the run.
