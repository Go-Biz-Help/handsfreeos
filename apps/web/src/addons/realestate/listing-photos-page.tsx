'use client';
/**
 * A listing's photos (board 34, design/realestate/ListingPhotos.dc.html): the deal's own uploaded images, in the
 * order they're shown, each with its caption and whether the public page shows it. The first is the one on the
 * flyer and at the top of the page. Every change saves the whole order at once.
 */
import { BROWSER_IMAGES } from '@hfos/core';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { uploadFile } from '@/components/files/upload-zone';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { FileItem } from '@/lib/api/types';
import { DealCrumb, firstNames } from './buyer-bits';
import { SignedPhoto } from './listing-bits';
import type { ListingPhoto, ListingView } from './types';
import { useAct } from './use-act';

type Arranged = { id: string; caption: string | null; public: boolean };

export function ListingPhotosPage({
  workspaceId,
  dealId,
  dealName,
  listing: l,
  files,
  sellers,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  listing: ListingView;
  files: readonly FileItem[];
  sellers: readonly string[];
  live: boolean;
}) {
  const photos = [...l.photos].sort((a, b) => a.position - b.position);
  const seller = firstNames(sellers) || 'the seller';
  const { busy, act } = useAct();
  const [adding, setAdding] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const onPage = photos.filter((p) => p.public).length;
  const fileOf = (p: ListingPhoto) => files.find((f) => f.id === p.fileId);
  const unused = files.filter(
    (f) => f.mimeType && BROWSER_IMAGES.has(f.mimeType) && !photos.some((p) => p.fileId === f.id),
  );

  /** Saves every photo, in order, with one changed the way `change` says. */
  const arrange = (next: Arranged[], done: string) =>
    act(
      'arrange',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.listing.photos_arrange', {
            body: { workspaceId, dealId, photos: next },
          }),
        ),
      done,
    );
  const now = (): Arranged[] =>
    photos.map((p) => ({ id: p.id, caption: p.caption, public: p.public }));
  const move = (i: number, by: -1 | 1) => {
    const next = now();
    const [p] = next.splice(i, 1);
    next.splice(i + by, 0, p!);
    void arrange(next, 'Moved.');
  };
  const add = async (fileId: string) =>
    unwrap(
      await apiBrowser().POST('/v1/commands/realestate.listing.photo_add', {
        body: { workspaceId, dealId, fileId },
      }),
    );

  return (
    <div data-testid="realestate-listing-photos">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Photos" />
      <PageHeader
        title="Photos"
        description={`${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} · ${onPage} on the public page`}
        actions={
          live ? (
            <>
              {unused.length ? (
                <Button variant="secondary" onClick={() => setAdding(true)}>
                  Add from the deal’s files
                </Button>
              ) : null}
              <Button
                loading={busy === 'upload'}
                onClick={() => upload.current?.click()}
                data-testid="photos-upload"
              >
                Upload photos
              </Button>
              <input
                ref={upload}
                type="file"
                accept="image/*"
                multiple
                hidden
                data-testid="photos-upload-input"
                onChange={(e) => {
                  const chosen = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (!chosen.length) return;
                  void act(
                    'upload',
                    async () => {
                      for (const file of chosen) {
                        const fileId = await uploadFile(workspaceId, 'custom_record', dealId, file);
                        await add(fileId);
                      }
                    },
                    chosen.length === 1 ? 'Photo added.' : `${chosen.length} photos added.`,
                  );
                }}
              />
            </>
          ) : null
        }
      />
      {photos.length === 0 ? (
        <Card className="p-5 text-[13.5px] text-text-2">
          No photos yet. Upload the listing’s photos; the first is the one on the flyer and at the
          top of the public page.
        </Card>
      ) : (
        <div
          className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
          data-testid="photos-grid"
        >
          {photos.map((p, i) => (
            <Card key={p.id} className="overflow-hidden p-0" data-testid="photo-tile">
              <SignedPhoto file={fileOf(p)} alt={p.caption ?? p.name} className="h-[130px]" />
              <div className="space-y-2 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold text-text-2">{i + 1}</span>
                  <Caption
                    photo={p}
                    disabled={!live}
                    onSave={(caption) =>
                      void arrange(
                        now().map((x) => (x.id === p.id ? { ...x, caption } : x)),
                        'Caption saved.',
                      )
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 whitespace-nowrap text-[12.5px] text-text-2">
                    <Switch
                      checked={p.public}
                      disabled={!live || busy === 'arrange'}
                      label={p.public ? 'On the public page' : 'Kept for you and the seller'}
                      onChange={(on) =>
                        void arrange(
                          now().map((x) => (x.id === p.id ? { ...x, public: on } : x)),
                          on ? 'It’s on the public page.' : `Kept for you and ${seller} only.`,
                        )
                      }
                    />
                    {p.public ? 'On the page' : 'Hidden'}
                  </label>
                  {live ? (
                    <div className="flex items-center gap-0.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Move earlier"
                        disabled={i === 0 || busy === 'arrange'}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Move later"
                        disabled={i === photos.length - 1 || busy === 'arrange'}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Take it off the listing"
                        loading={busy === `remove-${p.id}`}
                        onClick={() =>
                          void act(
                            `remove-${p.id}`,
                            async () =>
                              unwrap(
                                await apiBrowser().POST(
                                  '/v1/commands/realestate.listing.photo_remove',
                                  { body: { workspaceId, dealId, photoId: p.id } },
                                ),
                              ),
                            'Taken off the listing. The file stays on the deal.',
                          )
                        }
                      >
                        <X className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="mt-3 text-[12.5px] text-text-3">
        The first is the one on the flyer and at the top of the page. A switch off keeps a photo for
        you and {seller} only. The photos are proof for “Organize listing photos”.
      </p>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent
          title="Add from the deal’s files"
          description="Images already uploaded to the deal."
          className="w-[min(640px,calc(100vw-32px))]"
        >
          <div className="mt-4 grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
            {unused.map((f) => (
              <button
                key={f.id}
                type="button"
                className="overflow-hidden rounded-control border border-border text-left hover:bg-card-2"
                disabled={busy === `add-${f.id}`}
                onClick={() =>
                  void act(`add-${f.id}`, async () => add(f.id), 'Added to the listing.')
                }
              >
                <SignedPhoto file={f} alt={f.name} className="h-[100px]" />
                <span className="block truncate px-2 py-1.5 text-[12.5px]">{f.name}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A photo's caption, saved when it's left changed. */
function Caption({
  photo,
  disabled,
  onSave,
}: {
  photo: ListingPhoto;
  disabled: boolean;
  onSave: (caption: string | null) => void;
}) {
  const [words, setWords] = useState(photo.caption ?? '');
  return (
    <Input
      aria-label="Caption"
      value={words}
      placeholder="Caption"
      maxLength={120}
      disabled={disabled}
      className="h-8 text-[13px]"
      onChange={(e) => setWords(e.target.value)}
      onBlur={() => {
        const next = words.trim() || null;
        if (next !== (photo.caption ?? null)) onSave(next);
      }}
    />
  );
}
