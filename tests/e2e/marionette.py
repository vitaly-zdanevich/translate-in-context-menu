'''Minimal synchronous client for Firefox's built-in Marionette protocol.

The browser ships its server, so these tests need no third-party Python packages.
See https://firefox-source-docs.mozilla.org/remote/marionette/Protocol.html.
'''

import json
import socket
import time


class Marionette:
	'''Send the small subset of Marionette commands needed by the native-menu test.'''

	def __init__(self, port, timeout=20):
		'''Connect to a launching Firefox and check the protocol handshake.'''
		deadline = time.monotonic() + timeout
		while True:
			try:
				self.connection = socket.create_connection(('127.0.0.1', port), timeout=20)
				break
			except OSError:
				if time.monotonic() >= deadline:
					raise
				time.sleep(0.1)
		self.sequence = 0
		self.stream = self.connection.makefile('rb')
		hello = self._receive()
		assert hello['marionetteProtocol'] == 3, hello
		self.command('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {}}})

	def _receive(self):
		'''Read one UTF-8 JSON message with its byte-length prefix.'''
		length = bytearray()
		while (character := self.stream.read(1)) != b':':
			if not character:
				raise ConnectionError('Firefox closed the Marionette connection')
			length.extend(character)
		return json.loads(self.stream.read(int(length)))

	def command(self, name, parameters=None):
		'''Run a command and raise with Firefox diagnostics on protocol errors.'''
		self.sequence += 1
		payload = json.dumps([0, self.sequence, name, parameters or {}]).encode()
		self.connection.sendall(str(len(payload)).encode() + b':' + payload)
		kind, sequence, error, result = self._receive()
		assert kind == 1 and sequence == self.sequence
		if error:
			raise RuntimeError(f'{name}: {error}')
		return result

	def script(self, source, *arguments, context='content'):
		'''Execute JavaScript in the current page or privileged browser window.'''
		self.command('Marionette:SetContext', {'value': context})
		result = self.command('WebDriver:ExecuteScript', {
			'script': source,
			'args': list(arguments),
			'newSandbox': True,
			'sandbox': 'default',
			'scriptTimeout': 10000,
		})
		return result['value']

	def close(self):
		'''Release the automation session and its socket.'''
		try:
			self.command('WebDriver:DeleteSession')
		finally:
			self.stream.close()
			self.connection.close()
