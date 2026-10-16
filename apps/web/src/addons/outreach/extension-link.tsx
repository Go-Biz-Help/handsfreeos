'use client';
/**
 * Where the team downloads the browser extension (docs/outreach.md, decision 45): a link to its zip, which owners and
 * admins paste once, under For your team on Settings → General or right in the setup's install step. The zip lives
 * wherever the team keeps it (a shared drive, a release page), never in HandsFreeOS's code. Kept with the business's
 * Social Outreach settings (`extensionLink`), so everyone's setup shows it. A box to type in, so it keeps its own
 * Save where the rest of Settings saves as it's changed (decision 73).
 */
import { extensionLinkProblem, settingsToSave } from '@hfos/core/addons/outreach/chat-read';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldError, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useAct } from './use-act';

const L = SETUP_WORDS.link;

export function ExtensionLinkForm({
  workspaceId,
  settings,
  onSaved,
}: {
  workspaceId: string;
  /** The business's Social Outreach settings as saved: the others are kept as they are. */
  settings: Readonly<Record<string, unknown>>;
  onSaved?: () => void;
}) {
  // The link as it's read: one stored that stopped passing shows as none.
  const saved = settingsToSave(settings, {}).extensionLink ?? '';
  const [link, setLink] = useState(saved);
  // Checked here as the save checks it, so a link that won't pass says why at once.
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, errors, act } = useAct(onSaved);
  return (
    <div className="space-y-2" data-testid="outreach-extension-link">
      <div>
        <h3 className="text-[14px] font-semibold">{L.title}</h3>
        <p className="text-[13px] text-text-2">{L.about}</p>
      </div>
      <div>
        <Label htmlFor="outreach-extension-link-input">{L.label}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="outreach-extension-link-input"
            className="h-9 min-w-0 flex-1"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={link}
            maxLength={500}
            invalid={!!(problem ?? errors.extensionLink)}
            onChange={(e) => {
              setLink(e.target.value);
              setProblem(null);
            }}
            data-testid="outreach-extension-link-input"
          />
          <Button
            size="sm"
            disabled={link.trim() === saved || busy !== null}
            loading={busy === 'link'}
            onClick={() => {
              const wrong = extensionLinkProblem(link);
              setProblem(wrong);
              if (wrong) return;
              void act(
                'link',
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/addon.save_settings', {
                      body: {
                        workspaceId,
                        addonId: 'outreach',
                        settings: settingsToSave(settings, { extensionLink: link.trim() || null }),
                      },
                    }),
                  ),
                link.trim() ? L.saved : L.removed,
              );
            }}
            data-testid="outreach-extension-link-save"
          >
            Save
          </Button>
        </div>
        <FieldError>{problem ?? errors.extensionLink}</FieldError>
      </div>
    </div>
  );
}
