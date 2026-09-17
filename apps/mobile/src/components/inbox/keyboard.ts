import * as React from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * How much of the screen the keyboard covers, so the conversation lifts its composer above it. Android apps draw edge
 * to edge, so the window no longer shrinks for the keyboard; on an iPhone KeyboardAvoidingView left the box behind the
 * keyboard inside the screen's frame. Both phones measure it the same way here instead. On Android the height leaves out
 * the navigation bar, which the caller adds back.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = React.useState(0);
  React.useEffect(() => {
    const ios = Platform.OS === 'ios';
    const shown = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) =>
      setHeight(e.endCoordinates.height),
    );
    const hidden = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setHeight(0),
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return height;
}
