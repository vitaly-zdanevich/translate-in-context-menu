# Translate in Context Menu

[![Tests](https://github.com/vitaly-zdanevich/translate-in-context-menu/actions/workflows/tests.yml/badge.svg)](https://github.com/vitaly-zdanevich/translate-in-context-menu/actions/workflows/tests.yml)

A small Firefox extension that shows a Russian translation of selected text in the native context menu, or on your phone when you press **Alt+Shift+T**. Those translations use the official [Google Cloud Translation Basic API (v2)](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate), detect the source language automatically, and translate into Russian with your Google Cloud API key. **Alt+Shift+Y** instead pastes the selected text into an existing Yandex Translate tab, without an API key.

Modern JavaScript modules, native Firefox APIs, and `fetch`. No JavaScript dependencies, bundler, or installation of npm packages.

## Try it in Firefox

1. Use Firefox Desktop 156 or newer.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select this folder’s `manifest.json`.
4. Allow website access if Firefox asks. Automatic translation requires access to the page’s selection before you click a menu item.
5. Open `about:addons`, select **Translate in Context Menu**, and open **Preferences**. Paste your Google Cloud Translation API key and click **Save**.
6. Select text on an HTTP or HTTPS page and open its context menu. **Переводим…** changes to the Russian translation when it arrives.

The menu item stays clickable, including during loading and errors. Clicking it opens **Google Translate** in a new tab with the selected text and Russian as the target language. Long translations are shortened to fit the menu; the phone display shows the full translation. The API key and phone connection are managed in Firefox’s add-on Preferences.

Temporary add-ons are removed when Firefox closes. After editing the code, click **Reload** on the extension in `about:debugging`. See [Mozilla’s temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## Paste into an open Yandex Translate window

1. Open [Yandex Translate](https://translate.yandex.ru/) in another window of the same Firefox profile. Wait for its text field to become ready and select Russian as the target language.
2. Select text on a webpage in your working Firefox window.
3. Press **Alt+Shift+Y**. The extension replaces the contents of Yandex’s `#textarea` and triggers its input handler so Yandex translates the new text.

This shortcut uses Yandex’s existing language settings and needs no Google API key or local server. It does not use or replace your clipboard. With a destination in another window, your working window keeps focus. If the destination tab is hidden behind another tab, the extension activates it within its own window.

If several Yandex tabs are open, the shortcut prefers a tab in another window, then an active tab, then the most recently accessed one. It can also use another tab in the current window. It never pastes back into the source tab or opens a new destination. Missing tabs, empty selections, and an unavailable text field produce a native notification. You can change the shortcut in **about:addons → gear menu → Manage Extension Shortcuts**.

The shortcut sends the selected text to the existing Yandex webpage, which processes it through its own service. Only `https://translate.yandex.ru/` tabs in this Firefox profile are targeted; another browser or profile needs its own extension instance. This integration depends on Yandex’s page keeping its `#textarea` element and input behavior.

## Use your phone as a second screen

The phone display is a **plain HTTP live page** for Firefox on Android on the same local network. There are no certificates or service worker to set up. Keep the page open; it has no offline mode. A home-screen shortcut may be available through Firefox’s menu, but this HTTP MVP does not require PWA installation. See [Mozilla’s Android web app guide](https://support.mozilla.org/en-US/kb/use-web-apps-firefox-android) and [PWA installation requirements](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

On your computer, use Node.js 24 or newer, then run these commands from this folder. No packages need to be installed:

```sh
npm run phone:setup
npm run phone
```

The setup command detects the computer’s private IPv4 address and saves a random pairing token in `.local/phone/config.json`. If it finds multiple addresses, specify the one on the phone’s network:

```sh
npm run phone:setup -- 192.168.1.42
```

Use your computer’s actual address in place of the example. Setup preserves the pairing token when run again. Leave `npm run phone` running while using the display; **Ctrl+C** stops it.

1. Open the **Phone pairing URL** printed by the server in Firefox on your phone. Alternatively, open the base address, such as `http://192.168.1.42:8787`, and paste the printed pairing token. The page should say **Connected**.
2. In the desktop extension’s **Preferences → Phone display**, save the printed **Extension relay URL** and **Extension pairing token**. Your Google API key stays in its separate field on the desktop.
3. Select text on a webpage in desktop Firefox and press **Alt+Shift+T**. The phone shows the original text and Russian translation. The shortcut works while Firefox is focused, including selections in ordinary text inputs; password fields are excluded.

Change the shortcut in **about:addons → gear menu → Manage Extension Shortcuts** if your desktop intercepts it. The phone follows `prefers-color-scheme`: dark mode uses background `#000` and text `#bbb`.

The extension sends updates to the local server with HTTP POST. The phone keeps a single [Server-Sent Events connection](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) open for immediate updates, without polling or a WebSocket library. SSE suits this one-way display and is supported by Node’s built-in HTTP server and the browser’s `EventSource` API. The server retains only the latest update in RAM and sends it again when the phone reconnects.

If the phone cannot connect, check that both devices are on the same network, the server is running, and your firewall allows incoming TCP port **8787** from that network. Guest Wi-Fi may isolate devices. Use `http://` explicitly; if Firefox’s HTTPS-Only Mode intervenes, allow HTTP for this local address. When the computer’s LAN address changes, stop the server, run setup again, restart it with `npm run phone`, and update the extension URL and phone bookmark. Android may suspend background tabs or a locked phone; reopen the display to reconnect.

This mode sends the selected text, translation, and pairing credential **unencrypted over your LAN**. Use a trusted local network and keep the server off the public internet. The Google API key is never sent to the relay or phone. The pairing token is stored in the local config, extension preferences, and phone’s local storage; **Disconnect** on the phone forgets its token and clears its display. To revoke all pairings, stop the server, delete `.local/phone/config.json`, run setup again, restart with `npm run phone`, and enter the new token on each device.

## Get a Google Cloud API key

1. Follow [Google’s Cloud Translation setup guide](https://docs.cloud.google.com/translate/docs/setup): create or select a Google Cloud project, enable billing, and enable **Cloud Translation API**.
2. Open [Google Cloud Credentials](https://console.cloud.google.com/apis/credentials) for that project. Choose **Create credentials → API key** and create a standard API key. A service account is not needed for this extension. See [Google’s API key instructions](https://docs.cloud.google.com/docs/authentication/api-keys#create_an_api_key).
3. Under **API restrictions**, restrict the key to **Cloud Translation API** and save. Website/referrer restrictions do not fit this extension’s background requests, which send no page referrer. If you use an IP address restriction, it must match your current public IP. See [API key restrictions](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys).
4. Set suitable daily character quotas in [Cloud Translation quotas](https://docs.cloud.google.com/translate/quotas). The default daily character allowance is unlimited. [Budget alerts](https://docs.cloud.google.com/billing/docs/how-to/budgets) help monitor charges; an alerts-only budget does not stop spending.
5. Paste the key into the extension’s **Preferences** and click **Save**. Saving stores the key locally without contacting Google or making a billable test request. **Remove key** deletes it from this Firefox profile.

The Basic v2 API supports API keys; Advanced v3 requires a different authentication setup. See [Google’s authentication documentation](https://docs.cloud.google.com/translate/docs/authentication#api_keys).

## Google pricing

**For typical personal use, such as translating words and short phrases, this extension should be free for you.** The $10 credit is a free allowance, not a monthly fee.

Checked **2026-09-26** against [Google’s official Cloud Translation pricing](https://cloud.google.com/products/translate/pricing). Standard pay-as-you-go prices for the Basic NMT model used by this extension are in USD:

| Monthly text usage | Price |
| --- | --- |
| First 500,000 characters | **Free ($0)**, covered by the monthly credit |
| Usage above 500,000, through 1 billion characters | $20 per million characters |
| Above 1 billion characters | Contact Google sales |

The $10 credit is shared across Cloud Translation Basic and Advanced and does not roll over. Google counts input Unicode characters, including whitespace. Automatic source-language detection during translation adds no separate fee. For example, 1 million input characters in a month cost $10 after the full credit, assuming no other usage consumes it. Billing must still be enabled; check Google’s pricing page for current rates and local-currency pricing.

## Behavior and privacy

- With a saved API key, opening a context menu over selected text sends an uncached selection in an HTTPS POST body to `https://translation.googleapis.com/language/translate/v2`. The phone shortcut does the same after checking that the local relay is reachable. Simply selecting text does not send a request. Without a key, the menu asks you to set one in Preferences.
- The API key is sent to Google only in the `X-Goog-Api-Key` authentication header, never in the URL. No page URL, cookies, or browser history are included. Google still receives the request and its network metadata, including your IP address.
- The key is stored as plain text in this Firefox profile using `browser.storage.local`; it is not encrypted or synced. The password input only masks its display. The extension contains no bundled credentials. Remove the saved key in Preferences or revoke it in Google Cloud Credentials.
- Clicking the menu opens `translate.google.com` with the selection in the URL, so the text can appear in that tab’s browser history. This is separate from the Cloud API request.
- HTTP/HTTPS host access is required because Firefox exposes the selection in [`menus.onShown`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/onShown) only with host permission. The shortcuts run a small selection reader in the active tab’s frames using [`scripting.executeScript`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript). The Yandex shortcut also writes to its destination’s text field. Neither monitors typing nor runs automatically on page loads. There are no analytics.
- Successful menu and phone translations are cached in separate in-memory maps without entry limits. Firefox clears them when it unloads the background page or the extension stops. Each cache is cleared when its next translation uses a different API key. The extension, relay, and phone save no translation history to disk.
- Google API translations are limited to 5,000 Unicode characters. Requests time out after 10 seconds. Closing the menu cancels the pending request; failures appear in the menu and can be retried by reopening it.
- Firefox internal pages, protected browser pages, and local files are outside this MVP’s scope. Firefox’s built-in PDF viewer may also restrict access.

API keys do not remove Google Cloud quotas. The menu handles HTTP 429 and HTTP 403 errors; Google documents quota failures as HTTP 403. Check the key, API enablement, billing, and [quota settings](https://docs.cloud.google.com/translate/quotas) if requests fail.

The manifest declares `websiteContent` and `authenticationInfo` transmission using [Firefox’s built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Other display options

The phone display and Yandex tab integration are implemented. These alternatives would need additional work:

- **System popup:** Firefox’s [notifications API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications) can show a translation in a native notification. The operating system controls its size and lifetime, so long text may be shortened. This version uses notifications for shortcut setup and connection errors.
- **A terminal or `agy`:** [native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) connects Firefox to a separately installed and registered local program. A helper could pass text to a terminal display or invoke [Antigravity’s CLI](https://antigravity.google/docs/cli/headless/). It does not automatically paste into an already open terminal session. For displaying this extension’s Google translation, a small terminal reader would be sufficient; an additional AI call is unnecessary.

## Development

Load the source folder directly in Firefox; no build step is necessary. Node.js 24 or newer runs the local relay and tests; it does not have to be an LTS release. Python 3 is used for packaging and the Firefox end-to-end test, using its standard library only.

```sh
npm test
npm run test:coverage
npm run test:e2e
npm run build
```

These npm commands are shortcuts; **do not run `npm install`**. To run without npm:

```sh
node --test --test-isolation=none tests/*.test.js
python3 tests/e2e/firefox.py
python3 scripts/build.py
```

Tests use mock Google responses and do not send selected text to Google. Unit and local integration tests cover translation, menu behavior, preferences, shortcut cancellation, Yandex tab selection and input events, pairing, relay authentication, SSE reconnects, and phone rendering. Automated Yandex tests use mock tabs and fields without contacting Yandex. See [the Firefox end-to-end test instructions](tests/e2e/README.md) for its browser and display requirements.

[GitHub Actions](https://github.com/vitaly-zdanevich/translate-in-context-menu/actions/workflows/tests.yml) runs coverage, Firefox integration tests, and packaging on pushes to `main`, version tags, and pull requests. CI uses Node.js 24 and the latest stable Firefox; all JavaScript actions also run on Node.js 24. Successful runs attach the extension ZIP as the `firefox-extension` artifact. No API keys or pairing credentials are required.

Packaging writes `dist/translate-in-context-menu-1.0.0.zip` with only the manifest, extension source files, and icon. Keep this source folder to run the phone relay; its files and private pairing config are not bundled in the extension. A normal, permanent Firefox installation requires [Mozilla signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/); this MVP is ready for temporary loading.

Firefox’s [`menus.refresh()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/refresh) updates the open menu. [Background ES modules](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) keep the source directly runnable without a build tool.

The manifest explicitly sets `script-src 'self'; object-src 'none'` so Firefox does not upgrade the HTTP relay connection to HTTPS. Scripts still come only from the packaged extension, and the relay client accepts only private IPv4 or localhost HTTP addresses. See [Firefox’s Manifest V3 content security policy](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_Security_Policy#upgrade_insecure_network_requests_in_manifest_v3).

Firefox’s [`options_ui`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/options_ui) embeds the small preferences form in the native add-on manager with `open_in_tab: false`. Firefox requires an extension-owned HTML page for these controls; the form uses native HTML controls with minimal color styling and no dependencies.
