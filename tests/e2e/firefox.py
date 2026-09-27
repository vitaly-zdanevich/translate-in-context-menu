'''Exercise the extension inside Firefox, including its native context menu.'''

import functools
import http.server
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs, urlparse

from marionette import Marionette


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests' / 'fixtures'


class QuietHandler(http.server.SimpleHTTPRequestHandler):
	'''Serve deterministic test content without logging each request.'''

	def log_message(self, *_arguments):
		'''Keep successful browser tests quiet.'''


class FirefoxContextMenuTest(unittest.TestCase):
	'''Verify real selection and asynchronous native-popup refresh.'''

	@classmethod
	def setUpClass(cls):
		'''Launch Firefox with a fresh profile and install a mocked extension copy.'''
		cls.directory = tempfile.TemporaryDirectory(prefix='translation-firefox-')
		cls.addClassCleanup(cls.directory.cleanup)
		workspace = Path(cls.directory.name)
		extension = workspace / 'extension'
		extension.mkdir()
		shutil.copy(ROOT / 'manifest.json', extension)
		shutil.copytree(ROOT / 'src', extension / 'src')
		if (ROOT / 'icons').exists():
			shutil.copytree(ROOT / 'icons', extension / 'icons')
		shutil.copy(FIXTURES / 'google-translate.js', extension / 'src' / 'test-fetch.js')
		background = extension / 'src' / 'background.js'
		background.write_text("import './test-fetch.js';\n" + background.read_text())

		profile = workspace / 'profile'
		profile.mkdir()
		with socket.socket() as reservation:
			reservation.bind(('127.0.0.1', 0))
			port = reservation.getsockname()[1]
		preferences = {
			'marionette.port': port,
			# Keep test popups on this Firefox display, outside the desktop's D-Bus queue.
			'alerts.useSystemBackend': False,
			'browser.shell.checkDefaultBrowser': False,
			'browser.startup.homepage_override.mstone': 'ignore',
			'browser.startup.page': 0,
			'browser.aboutwelcome.enabled': False,
			'browser.newtabpage.enabled': False,
			'browser.newtabpage.activity-stream.feeds.telemetry': False,
			'datareporting.policy.dataSubmissionPolicyBypassNotification': True,
			'datareporting.healthreport.uploadEnabled': False,
			'toolkit.telemetry.enabled': False,
			'app.update.auto': False,
		}
		profile.joinpath('user.js').write_text('\n'.join(
			f'user_pref({json.dumps(key)}, {json.dumps(value)});'
			for key, value in preferences.items()
		))
		cls.log = workspace.joinpath('firefox.log').open('w+')
		cls.addClassCleanup(cls.log.close)
		cls.process = subprocess.Popen([
			os.environ.get('FIREFOX_BIN', 'firefox'), '--no-remote',
			'--profile', str(profile), '--marionette',
			'--remote-allow-system-access', 'about:blank',
		], stdout=cls.log, stderr=cls.log)
		cls.addClassCleanup(cls.stop_browser)
		cls.browser = Marionette(port)
		cls.addClassCleanup(cls.browser.close)
		cls.browser.command('Addon:Install', {'path': str(extension), 'temporary': True})
		cls.extension_id = json.loads((ROOT / 'manifest.json').read_text())['browser_specific_settings']['gecko']['id']
		cls.options_url = cls.browser.script('''
			const { ExtensionParent } = ChromeUtils.importESModule(
				'resource://gre/modules/ExtensionParent.sys.mjs'
			);
			return ExtensionParent.GlobalManager.getExtension(arguments[0]).baseURI.spec + 'src/options.html';
		''', cls.extension_id, context='chrome')
		handler = functools.partial(QuietHandler, directory=str(FIXTURES))
		cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
		cls.addClassCleanup(cls.server.server_close)
		threading.Thread(target=cls.server.serve_forever, daemon=True).start()
		cls.addClassCleanup(cls.server.shutdown)
		cls.fixture_url = f'http://127.0.0.1:{cls.server.server_port}/selection.html'

	def setUp(self):
		'''Save a fake key through the production preferences before each check.'''
		self.embedded_preferences = False
		self.navigate(self.options_url)
		self.wait_for_preferences()
		self.save_key()
		self.navigate(self.fixture_url)

	def navigate(self, url):
		'''Navigate the selected tab after leaving any embedded preferences frame.'''
		self.browser.command('Marionette:SetContext', {'value': 'content'})
		self.browser.command('WebDriver:SwitchToFrame', {'id': None})
		self.browser.command('WebDriver:Navigate', {'url': url})

	def wait_for_preferences(self):
		'''Wait until asynchronous storage loading enables the preferences form.'''
		self.wait_for(lambda: self.preferences_script('''
			return document.getElementById('controls')?.disabled === false;
		'''), 'the API-key preferences to load')

	def save_key(self):
		'''Submit the real form with a fake credential and wait for persistence.'''
		self.preferences_script('''
			document.getElementById('api-key').value = 'test-api-key';
			document.getElementById('settings').requestSubmit();
		''')
		self.wait_for(lambda: self.preferences_script('''
			return document.getElementById('status').textContent === 'API key saved.';
		'''), 'the API key to save')

	def preferences_script(self, source):
		'''Use Firefox's automation actor for the remote native preferences browser.'''
		if not self.embedded_preferences:
			return self.browser.script(source)
		return self.browser.script('''
			const frame = gBrowser.selectedBrowser.contentDocument.getElementById('addon-inline-options');
			return frame.browsingContext.currentWindowGlobal.getActor('MarionetteCommands')
				.executeScript(arguments[0], [], { sandboxName: 'default', newSandbox: true, timeout: 10000 });
		''', source, context='chrome')

	def remove_key(self):
		'''Remove the fake credential through the visible preferences button.'''
		self.preferences_script("document.getElementById('remove-key').click();")
		self.wait_for(lambda: self.preferences_script('''
			return document.getElementById('status').textContent === 'API key removed.';
		'''), 'the API key to be removed')

	def request_count(self):
		'''Read the fixture's counter to detect accidental requests without a key.'''
		return self.preferences_script('''
			return window.wrappedJSObject.browser.storage.session.get('e2eRequestCount')
				.then(({ e2eRequestCount = 0 }) => e2eRequestCount);
		''')

	def reload_embedded_preferences(self):
		'''Reload the native preferences frame to verify stored settings persist.'''
		previous_window = self.browser.script('''
			const frame = gBrowser.selectedBrowser.contentDocument.getElementById('addon-inline-options');
			const previous = frame.browsingContext.currentWindowGlobal.innerWindowId;
			frame.reload();
			return previous;
		''', context='chrome')
		self.wait_for(lambda: self.browser.script('''
			const current = gBrowser.selectedBrowser.contentDocument.getElementById('addon-inline-options')
				.browsingContext.currentWindowGlobal;
			return current.innerWindowId !== arguments[0] && current.documentURI.spec === arguments[1];
		''', previous_window, self.options_url, context='chrome'), 'the native preferences to reload')
		self.wait_for_preferences()

	@classmethod
	def stop_browser(cls):
		'''Terminate the isolated Firefox process, escalating only to its own kill.'''
		cls.process.terminate()
		try:
			cls.process.wait(timeout=10)
		except subprocess.TimeoutExpired:
			cls.process.kill()
			cls.process.wait(timeout=10)

	def wait_for(self, predicate, description, timeout=10):
		'''Poll browser state until ready and report the last observed value.'''
		deadline = time.monotonic() + timeout
		last = None
		while time.monotonic() < deadline:
			last = predicate()
			if last:
				return last
			time.sleep(0.05)
		self.fail(f'Timed out waiting for {description}; last value: {last}')

	def open_menu(self, element_id, select=True):
		'''Select fixture text and perform a real right mouse click over it.'''
		position = self.browser.script('''
			const element = document.getElementById(arguments[0]);
			const selection = window.getSelection();
			selection.removeAllRanges();
			if (arguments[1]) {
				selection.selectAllChildren(element);
			}
			const bounds = element.getBoundingClientRect();
			return { x: Math.round(bounds.x + 10), y: Math.round(bounds.y + bounds.height / 2) };
		''', element_id, select)
		self.browser.command('WebDriver:PerformActions', {'actions': [{
			'type': 'pointer',
			'id': 'mouse',
			'parameters': {'pointerType': 'mouse'},
			'actions': [
				{'type': 'pointerMove', 'duration': 0, 'origin': 'viewport', **position},
				{'type': 'pointerDown', 'button': 2},
				{'type': 'pointerUp', 'button': 2},
			],
		}]})
		self.wait_for(lambda: self.browser.script('''
			return document.getElementById('contentAreaContextMenu').state === 'open';
		''', context='chrome'), 'the native context menu to open')

	def close_menu(self):
		'''Dismiss the native popup before another selection or navigation.'''
		self.browser.script('''
			document.getElementById('contentAreaContextMenu').hidePopup();
		''', context='chrome')
		self.wait_for(lambda: self.browser.script('''
			return document.getElementById('contentAreaContextMenu').state === 'closed';
		''', context='chrome'), 'the native context menu to close')

	def menu_item(self):
		'''Read only the extension's visible native menu item.'''
		return self.browser.script('''
			const popup = document.getElementById('contentAreaContextMenu');
			const item = Array.from(popup.querySelectorAll('menuitem'))
				.find(element => element.id.includes('translate-to-russian') && !element.hidden);
			return item ? { label: item.label, disabled: item.disabled, id: item.id } : null;
		''', context='chrome')

	def wait_for_label(self, expected):
		'''Wait for a refreshed menu label without reopening the popup.'''
		return self.wait_for(
			lambda: (item := self.menu_item()) and item['label'] == expected and item,
			f'menu label {expected!r}',
		)

	def test_translation_in_the_open_menu(self):
		'''A selected phrase changes loading text into Russian in the open menu.'''
		self.open_menu('greeting')
		self.wait_for_label('Переводим…')
		item = self.wait_for_label('Привет, мир!')
		self.assertFalse(item['disabled'])
		self.close_menu()

	def test_dismissed_request_cannot_replace_new_translation(self):
		'''A late response for a dismissed menu cannot overwrite a new selection.'''
		self.open_menu('slow')
		self.wait_for_label('Переводим…')
		self.close_menu()
		self.open_menu('second')
		self.wait_for_label('Переводим…')
		self.wait_for_label('Доброе утро!')
		# Wait beyond the deliberately uncancellable first request's response.
		time.sleep(0.9)
		self.assertEqual(self.menu_item()['label'], 'Доброе утро!')
		self.close_menu()

	def test_network_error_is_visible_in_the_menu(self):
		'''Network errors replace the loading label without opening another UI.'''
		self.open_menu('failure')
		self.wait_for_label('Переводим…')
		self.wait_for_label('Не удалось подключиться к Google Translate. Проверьте соединение.')
		self.close_menu()

	def test_no_selection_has_no_translation_item(self):
		'''The translation row appears only when the webpage has selected text.'''
		self.open_menu('unselected', select=False)
		self.assertIsNone(self.menu_item())
		self.close_menu()

	def test_preferences_save_and_remove_key_without_requests(self):
		'''Native Add-ons Manager preferences save and remove the key without requests.'''
		self.navigate(self.options_url)
		self.wait_for_preferences()
		before = self.request_count()
		self.remove_key()
		self.navigate(self.fixture_url)
		self.open_menu('greeting')
		item = self.wait_for_label('Укажите API-ключ в настройках расширения')
		self.assertFalse(item['disabled'])
		self.close_menu()
		self.browser.script('BrowserAddonUI.openAddonsMgr(arguments[0]);',
			f'addons://detail/{self.extension_id}/preferences', context='chrome')
		self.wait_for(lambda: self.browser.script('''
			return gBrowser.selectedBrowser.currentURI.spec === 'about:addons'
				&& gBrowser.selectedBrowser.contentDocument?.getElementById('addon-inline-options')
					?.browsingContext?.currentWindowGlobal?.documentURI.spec === arguments[0];
		''', self.options_url, context='chrome'), 'Firefox native embedded preferences')
		self.embedded_preferences = True
		self.wait_for_preferences()
		guidance = self.preferences_script('''
			return { text: document.body.textContent, links: Array.from(document.links, link => link.href) };
		''')
		for instruction in ['Create credentials → API key', 'enable billing', '500,000 characters per month', '$10 credit']:
			self.assertIn(instruction, guidance['text'])
		for url in ['https://docs.cloud.google.com/translate/docs/setup', 'https://console.cloud.google.com/apis/credentials', 'https://cloud.google.com/products/translate/pricing']:
			self.assertIn(url, guidance['links'])
		self.assertEqual(self.preferences_script("return document.getElementById('api-key').type;"), 'password')
		self.assertEqual(self.preferences_script("return document.getElementById('api-key').value;"), '')
		self.assertEqual(self.request_count(), before)
		self.save_key()
		self.reload_embedded_preferences()
		self.assertEqual(self.preferences_script("return document.getElementById('api-key').value;"), 'test-api-key')
		self.remove_key()
		self.reload_embedded_preferences()
		self.assertEqual(self.preferences_script("return document.getElementById('api-key').value;"), '')
		self.assertEqual(self.request_count(), before)

	def test_suspended_background_wakes_on_menu_open(self):
		'''The persisted menu wakes an MV3 event page and restores its listeners.'''
		extension_id = json.loads((ROOT / 'manifest.json').read_text())['browser_specific_settings']['gecko']['id']
		state = self.browser.script('''
			const { ExtensionParent } = ChromeUtils.importESModule(
				'resource://gre/modules/ExtensionParent.sys.mjs'
			);
			const extension = ExtensionParent.GlobalManager.getExtension(arguments[0]);
			return extension.terminateBackground({ disableResetIdleForTest: true })
				.then(() => extension.backgroundState);
		''', extension_id, context='chrome')
		self.assertEqual(state, 'stopped')
		self.open_menu('second')
		self.wait_for_label('Переводим…')
		self.wait_for_label('Доброе утро!')
		self.close_menu()

	def click_menu_item(self, item):
		'''Click the real native row through Firefox's automation input handling.'''
		element = self.browser.script('return document.getElementById(arguments[0]);', item['id'], context='chrome')
		self.browser.command('WebDriver:ElementClick', {'id': next(iter(element.values()))})

	def test_click_opens_google_translate_for_the_selection(self):
		'''A loading menu remains clickable and supplies the selected text to Google.'''
		self.browser.script('''
			window.e2eOriginalAddTab = gBrowser.addTab;
			window.e2eTranslationUrl = '';
			gBrowser.addTab = function(url, options) {
				if (String(url).startsWith('https://translate.google.com/')) {
					window.e2eTranslationUrl = String(url);
					url = 'about:blank';
				}
				return window.e2eOriginalAddTab.call(this, url, options);
			};
		''', context='chrome')
		try:
			self.open_menu('greeting')
			item = self.wait_for_label('Переводим…')
			self.assertFalse(item['disabled'])
			self.click_menu_item(item)
			url = self.wait_for(lambda: self.browser.script('return window.e2eTranslationUrl;', context='chrome'),
				'the Google Translate tab request')
			self.assertEqual(urlparse(url).netloc, 'translate.google.com')
			self.assertEqual(parse_qs(urlparse(url).query), {
				'sl': ['auto'], 'tl': ['ru'], 'text': ['Hello, world!'], 'op': ['translate'],
			})
		finally:
			self.browser.script('''
				gBrowser.addTab = window.e2eOriginalAddTab;
				if (window.e2eTranslationUrl) gBrowser.removeTab(gBrowser.selectedTab);
				delete window.e2eOriginalAddTab;
				delete window.e2eTranslationUrl;
			''', context='chrome')

	def check_phone_hotkey(self, host):
		'''Send a real keyboard shortcut through the extension and HTTP/SSE relay.'''
		token = 'a' * 64
		relay = subprocess.Popen([
			'node', '--input-type=module', '-e', '''
				import { startBridge } from './bridge/server.js';
				const server = await startBridge({ host: process.argv[1], port: 0, token: 'a'.repeat(64) });
				console.log(server.address().port);
			''', host,
		], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
		self.addCleanup(self.stop_relay, relay)
		port = relay.stdout.readline().strip()
		self.assertTrue(port.isdigit(), f'Local relay failed to start: {port}')
		origin = f'http://{host}:{port}'
		self.navigate(self.options_url)
		self.wait_for_preferences()
		self.wait_for(lambda: self.browser.script("return document.getElementById('phone-controls').disabled === false;"),
			'phone preferences to load')
		self.browser.script('''
			document.getElementById('phone-url').value = arguments[0];
			document.getElementById('phone-token').value = arguments[1];
			document.getElementById('phone-settings').requestSubmit();
		''', origin, token)
		self.wait_for(lambda: self.browser.script("return document.getElementById('phone-status').textContent === 'Phone connection saved.';"),
			'phone connection settings to save')
		self.navigate(self.fixture_url)
		fixture_handle = self.browser.command('WebDriver:GetWindowHandle')['value']
		phone_handle = self.browser.command('WebDriver:NewWindow', {'type': 'tab'})['handle']
		self.addCleanup(self.close_phone_tab, phone_handle, fixture_handle)
		self.browser.command('WebDriver:SwitchToWindow', {'handle': phone_handle})
		self.navigate(f'{origin}/#token={token}')
		self.wait_for(lambda: self.browser.script("return document.getElementById('connection-status')?.textContent === 'Connected';"),
			'the phone EventSource connection')
		self.assertEqual(self.browser.script('return location.hash;'), '')
		self.browser.command('WebDriver:SwitchToWindow', {'handle': fixture_handle})
		self.browser.script('''
			window.focus();
			window.getSelection().selectAllChildren(document.getElementById('greeting'));
		''')
		# Xvfb key synthesis does not dispatch extension shortcuts reliably. Exercise
		# Firefox's registered shortcut command; physical key capture is a manual check.
		self.browser.script('''
			const keyset = document.getElementById('ext-keyset-id-translate-in-context-menu_local_extension');
			const key = keyset.querySelector('key');
			if (key.getAttribute('key') !== 'T' || key.getAttribute('modifiers') !== 'alt,shift') {
				throw new Error('The expected Alt+Shift+T shortcut was not registered');
			}
			key.dispatchEvent(new Event('command', { bubbles: true }));
		''', context='chrome')
		# Keep the selected webpage focused until the command has read its selection.
		try:
			self.wait_for(lambda: self.browser.script('''
				const phone = Array.from(gBrowser.browsers).find(browser => browser.currentURI.spec.startsWith(arguments[0]));
				return phone.browsingContext.currentWindowGlobal.getActor('MarionetteCommands')
					.executeScript("return document.getElementById('original').textContent === 'Hello, world!';", [],
						{ sandboxName: 'default', newSandbox: true, timeout: 10000 });
			''', origin, context='chrome'), 'the keyboard command to publish selected text')
		except AssertionError:
			self.navigate(self.options_url)
			diagnostics = self.browser.script('return window.wrappedJSObject.browser.storage.session.get(null);')
			self.fail(f'The shortcut did not reach the phone: {diagnostics}')
		self.browser.command('Marionette:SetContext', {'value': 'content'})
		self.browser.command('WebDriver:SwitchToWindow', {'handle': phone_handle})
		self.wait_for(lambda: self.browser.script("return document.getElementById('translation').textContent === 'Привет, мир!';"),
			'the translated text on the phone display')
		self.assertEqual(self.browser.script("return document.getElementById('original').textContent;"), 'Hello, world!')

	@staticmethod
	def stop_relay(relay):
		'''Stop only the relay child created by this test and close its streams.'''
		relay.terminate()
		relay.wait(timeout=10)
		relay.stdout.close()
		relay.stderr.close()

	def close_phone_tab(self, phone_handle, fixture_handle):
		'''Close the temporary display tab and restore the fixture selection tab.'''
		self.browser.command('Marionette:SetContext', {'value': 'content'})
		self.browser.command('WebDriver:SwitchToWindow', {'handle': phone_handle})
		self.browser.command('WebDriver:CloseWindow')
		self.browser.command('WebDriver:SwitchToWindow', {'handle': fixture_handle})

	def test_hotkey_reaches_phone_over_loopback(self):
		'''Alt+Shift+T sends a selected-text translation to a real local phone page.'''
		self.check_phone_hotkey('127.0.0.1')

	def test_notification_shortcut_translates_selected_text(self):
		'''Alt+Shift+N displays a notification without phone settings.'''
		self.navigate(self.options_url)
		self.wait_for_preferences()
		self.browser.script('''
			const extension = window.wrappedJSObject.browser;
			return Promise.all([
				extension.storage.local.remove(['phoneServerUrl', 'phoneToken']),
				extension.storage.session.remove([
					'e2eLastCommand', 'e2eNotification', 'e2eNotificationOptions', 'e2eNotificationAccepted',
					'e2eNotificationShown',
				]),
			]);
		''')
		before = self.request_count()
		options_handle = self.browser.command('WebDriver:GetWindowHandle')['value']
		fixture_handle = self.browser.command('WebDriver:NewWindow', {'type': 'tab'})['handle']
		self.addCleanup(self.close_phone_tab, fixture_handle, options_handle)
		self.browser.command('WebDriver:SwitchToWindow', {'handle': fixture_handle})
		self.navigate(self.fixture_url)
		self.browser.script('''
			window.focus();
			window.getSelection().selectAllChildren(document.getElementById('greeting'));
		''')
		tabs_before = self.browser.command('WebDriver:GetWindowHandles')
		self.browser.script('''
			const keyset = document.getElementById('ext-keyset-id-translate-in-context-menu_local_extension');
			const key = Array.from(keyset.querySelectorAll('key'))
				.find(element => element.getAttribute('key') === 'N');
			if (key?.getAttribute('modifiers') !== 'alt,shift') {
				throw new Error('The expected Alt+Shift+N shortcut was not registered');
			}
			key.dispatchEvent(new Event('command', { bubbles: true }));
		''', context='chrome')
		# Query the background preferences tab without taking focus from the selection.
		notification = self.wait_for(lambda: self.browser.script('''
			const preferences = Array.from(gBrowser.browsers)
				.find(browser => browser.currentURI.spec === arguments[0]);
			return preferences.browsingContext.currentWindowGlobal.getActor('MarionetteCommands')
				.executeScript(`
					return window.wrappedJSObject.browser.storage.session.get(null)
						.then(state => state.e2eNotificationAccepted && state.e2eNotificationShown && state);
				`, [], { sandboxName: 'default', newSandbox: true, timeout: 10000 });
		''', self.options_url, context='chrome'), 'Firefox to report the translation notification as shown')
		self.assertEqual(notification['e2eLastCommand'], 'translate-in-notification')
		self.assertEqual(notification['e2eNotificationAccepted'], 'selection-translation')
		self.assertEqual(notification['e2eNotificationShown'], 'selection-translation')
		self.assertEqual(notification['e2eNotification'], 'Привет, мир!')
		options = notification['e2eNotificationOptions']
		self.assertEqual(options['type'], 'basic')
		self.assertEqual(options['title'], 'Перевод на русский')
		self.assertEqual(options['message'], 'Привет, мир!')
		self.assertTrue(options['iconUrl'].endswith('/icons/translate.svg'))
		self.assertEqual(notification['e2eRequestCount'], before + 1)
		self.browser.command('Marionette:SetContext', {'value': 'content'})
		self.assertEqual(self.browser.command('WebDriver:GetWindowHandles'), tabs_before)
		self.assertEqual(self.browser.command('WebDriver:GetWindowHandle')['value'], fixture_handle)
		self.assertEqual(self.browser.script('return location.href;'), self.fixture_url)
		self.assertEqual(self.browser.script('return window.getSelection().toString();'), 'Hello, world!')
		self.navigate(self.options_url)
		self.browser.script("return window.wrappedJSObject.browser.notifications.clear('selection-translation');")

	def test_hotkey_reaches_phone_over_private_lan(self):
		'''Private-LAN HTTP also works through the extension's real fetch and CSP.'''
		interfaces = json.loads(subprocess.check_output([
			'node', '--input-type=module', '-e',
			"import os from 'node:os'; console.log(JSON.stringify(os.networkInterfaces()));",
		], text=True))
		networks = [ipaddress.ip_network(network) for network in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']]
		host = next((entry['address'] for entries in interfaces.values() for entry in entries
			if entry['family'] == 'IPv4' and not entry['internal']
			and any(ipaddress.ip_address(entry['address']) in network for network in networks)), None)
		if host is None:
			self.skipTest('No private IPv4 interface is available for the LAN fetch check')
		self.check_phone_hotkey(host)

	def tearDown(self):
		'''Close any remaining popup so failures do not affect later checks.'''
		self.browser.script('''
			document.getElementById('contentAreaContextMenu').hidePopup();
		''', context='chrome')
		if self.embedded_preferences:
			self.browser.script('gBrowser.removeTab(gBrowser.selectedTab);', context='chrome')
			self.embedded_preferences = False


if __name__ == '__main__':
	unittest.main(verbosity=2)
