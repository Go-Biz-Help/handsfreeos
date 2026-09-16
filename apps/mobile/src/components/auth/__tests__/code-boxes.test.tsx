import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { CodeBoxes } from '@/components/auth/code-boxes';

function Harness({ onComplete }: { onComplete: (code: string) => void }) {
  const [code, setCode] = React.useState('');
  return (
    <CodeBoxes
      value={code}
      onChange={(next) => {
        setCode(next);
        if (next.length === 6) onComplete(next);
      }}
    />
  );
}

describe('CodeBoxes', () => {
  it('takes a pasted code, keeping digits only and at most six', async () => {
    const onComplete = jest.fn();
    await render(<Harness onComplete={onComplete} />);
    await fireEvent.changeText(screen.getByLabelText('The 6-digit code'), ' 482-917 99');
    expect(onComplete).toHaveBeenCalledWith('482917');
    for (const digit of ['4', '8', '2', '9', '1', '7'])
      expect(screen.getByText(digit)).toBeOnTheScreen();
  });

  it('shows each digit as it is typed', async () => {
    const onComplete = jest.fn();
    await render(<Harness onComplete={onComplete} />);
    const field = screen.getByLabelText('The 6-digit code');
    await fireEvent.changeText(field, '48');
    expect(screen.getByText('4')).toBeOnTheScreen();
    expect(screen.getByText('8')).toBeOnTheScreen();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
