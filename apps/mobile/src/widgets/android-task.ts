import { Platform } from 'react-native';
import { registerWidgetTaskHandler } from 'react-native-android-widget';

import { isAndroidWidget, renderAndroidWidget } from './android';
import { readStoredWidgets } from './store';

/**
 * What Android starts the app for, with no screen, to draw a home-screen widget (docs/phone-widgets.md): one being
 * added or resized, and its regular update every 30 minutes, when the latest moment of the copy is drawn (so an
 * appointment that began shows as Now within half an hour). It must be registered before the app renders anything, at
 * the top of the app's entry (`index.ts`). Taps open the app's own links, so there's nothing to do for a click.
 */
if (Platform.OS === 'android') {
  registerWidgetTaskHandler(async ({ widgetInfo, widgetAction, renderWidget }) => {
    if (widgetAction === 'WIDGET_DELETED' || widgetAction === 'WIDGET_CLICK') return;
    if (!isAndroidWidget(widgetInfo.widgetName)) return;
    renderWidget(
      renderAndroidWidget(widgetInfo.widgetName, readStoredWidgets(), widgetInfo, Date.now()),
    );
  });
}
