'use client';
/**
 * Your link, at the top of the Playbook (docs/socialcontent.md, "Your link"; the owner, 24 Nov 2026): the link the
 * business's posts send people to, and where it goes on each network: in the post, link in bio, or the first comment
 * once the post is up. The AI only mentions a link when there's one here, and says where to find it. Owners and
 * admins change it; everyone else sees it.
 */
import { POSTING_NETWORKS, type PostingNetwork } from '@hfos/core/addons/socialcontent/calendar';
import {
  DEFAULT_LINK_PLACES,
  LINK,
  LINK_PLACES,
  type LinkPlace,
} from '@hfos/core/addons/socialcontent/links';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import { Link2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useAct } from './use-act';

export function LinkCard({
  workspaceId,
  link,
  places,
  mayManage,
}: {
  workspaceId: string;
  link: string | null;
  places: Readonly<Record<PostingNetwork, LinkPlace>> | undefined;
  mayManage: boolean;
}) {
  const api = apiBrowser();
  const { busy, act } = useAct();
  const [typed, setTyped] = useState(link ?? '');
  const shown = places ?? DEFAULT_LINK_PLACES;
  const off = !mayManage || busy !== null;
  const save = (
    key: string,
    body: { link?: string | null; places?: Partial<Record<PostingNetwork, LinkPlace>> },
  ) =>
    act(
      key,
      () =>
        api
          .POST('/v1/commands/socialcontent.link.save', { body: { workspaceId, ...body } })
          .then(unwrap),
      (out) =>
        body.link === null
          ? W.link.removed
          : out.carried
            ? `${W.link.saved} ${W.link.carried(out.carried)}`
            : W.link.saved,
    );
  return (
    <Card className="p-4 md:p-5" data-testid="socialcontent-link">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-text-3" strokeWidth={1.75} aria-hidden />
        <h2 className="text-[15px] font-semibold">{W.link.title}</h2>
      </div>
      <p className="mt-1 text-[13px] text-text-2">{W.link.intro}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Input
          inputSize="sm"
          className="min-w-0 flex-1"
          value={typed}
          maxLength={LINK.most}
          placeholder={W.link.placeholder}
          aria-label={W.link.label}
          disabled={!mayManage}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="socialcontent-link-input"
        />
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'link'}
          disabled={off || !typed.trim() || typed.trim() === (link ?? '')}
          onClick={() => void save('link', { link: typed.trim() })}
          data-testid="socialcontent-link-save"
        >
          {busy === 'link' ? W.link.saving : W.link.save}
        </Button>
        {link ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'remove'}
            disabled={off}
            onClick={() => {
              setTyped('');
              void save('remove', { link: null });
            }}
            data-testid="socialcontent-link-remove"
          >
            {W.link.remove}
          </Button>
        ) : null}
      </div>
      {!link ? <p className="mt-2 text-[12.5px] text-text-3">{W.link.none}</p> : null}
      <div className="mt-4">
        <div className="text-[13.5px] font-medium">{W.link.where}</div>
        <div className="mt-2 space-y-2">
          {POSTING_NETWORKS.map((n) => (
            <div
              key={n}
              className="rounded-[10px] border border-border p-3"
              data-testid={`socialcontent-link-${n}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13.5px] font-medium">{networkName(n)}</span>
                <Segmented
                  value={shown[n]}
                  onChange={(place) => {
                    if (place !== shown[n]) void save(`place:${n}`, { places: { [n]: place } });
                  }}
                  ariaLabel={`${W.link.where}: ${networkName(n)}`}
                  options={LINK_PLACES.map((p) => ({
                    value: p,
                    label: W.link.places[p],
                    disabled: off,
                    testId: `socialcontent-link-${n}-${p}`,
                  }))}
                />
              </div>
              <p className="mt-1 text-[12.5px] text-text-3">{W.link.hint(n, shown[n])}</p>
            </div>
          ))}
        </div>
      </div>
      {!mayManage ? <p className="mt-3 text-[12.5px] text-text-3">{W.link.onlyManagers}</p> : null}
    </Card>
  );
}
