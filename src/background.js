import { registerMenu } from './menu.js';
import { registerHotkey } from './hotkey.js';
import { registerYandexShortcut } from './yandex.js';

// Register listeners immediately so Firefox can wake this MV3 event page.
registerMenu(browser);
registerHotkey(browser);
registerYandexShortcut(browser);
