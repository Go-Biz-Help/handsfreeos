'use client';
/**
 * Let the extension get your file, on the Friends tab (docs/outreach.md, decisions 16 and 43): the four steps of
 * getting Facebook's download file, each asked of the person's computer. It opens Facebook's own pages in a tab the
 * person can see and presses the buttons there; Facebook asks for their password and PIN, which they type there
 * themselves. Bringing the zips in from the downloads folder is the extension's too; picking them here
 * (./download-card.tsx) stays as it is.
 */
import { Card } from '@/components/ui/card';
import { AskButton } from './asks';
import type { Asks } from './types';

type FileKind = 'file_request' | 'file_download' | 'file_backup' | 'file_in';

const STEPS: readonly { kind: FileKind; says: string; button: string }[] = [
  { kind: 'file_request', says: 'Ask Facebook for your file', button: 'Ask Facebook' },
  {
    kind: 'file_download',
    says: 'Download it once Facebook emails you',
    button: 'Download my file',
  },
  {
    kind: 'file_backup',
    says: 'Get your chat backup, for newer chats',
    button: 'Get my chat backup',
  },
  {
    kind: 'file_in',
    says: 'Bring in the files from your downloads',
    button: 'Bring them in',
  },
];

export function FileAsksCard({ workspaceId, asks }: { workspaceId: string; asks: Asks }) {
  return (
    <Card className="p-4" data-testid="file-asks">
      <h3 className="text-[15px] font-semibold">Let the extension get your file</h3>
      <ol className="mt-3 grid gap-3">
        {STEPS.map((step, i) => (
          <li key={step.kind} className="grid gap-1.5" data-testid={`file-ask-${step.kind}`}>
            <span className="text-[13px]">
              <span className="tabular-nums text-text-3">{i + 1}.</span> {step.says}
            </span>
            <AskButton
              workspaceId={workspaceId}
              asks={asks}
              ask={{ kind: step.kind }}
              label={step.button}
              testId={`ask-${step.kind}`}
            />
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[12.5px] text-text-3">
        Your computer opens Facebook in a tab and presses the buttons there. Type your password or
        PIN there when Facebook asks.
      </p>
    </Card>
  );
}
