import { DemoStart, type DemoPlace, type DemoSceneSummary } from '@/components/admin/demo-start';
import { apiServer, getMe, unwrap } from '@/lib/api/server';
import { DEMO_BUSINESS, DEMO_SCENES, voiceoverScript } from '@/lib/demo/scenes';

/**
 * Admin → Demo player: where the scripted scenes for videos and live shows start (lib/demo/README.md). The founder
 * plays them in Bright Path Home Services, the reviewers' made-up business, opened as its owner; anyone in support
 * can play them in a business of their own. Each scene's voiceover is here too, to read before recording.
 */
export default async function DemoPlayerPage() {
  const { api } = await apiServer();
  const [me, { staff }] = await Promise.all([
    getMe(),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrap),
  ]);
  const founder = staff?.founder ?? false;
  // Found by its name, as the seed writes it; only the founder can open it as its owner, so only they look.
  const demo = founder
    ? await api
        .POST('/v1/queries/platform.business.list', {
          body: { search: DEMO_BUSINESS, sort: 'name', limit: 10 },
        })
        .then(unwrap)
        .then((l) => l.businesses.find((b) => b.name === DEMO_BUSINESS) ?? null)
        .catch(() => null)
    : null;
  const places: DemoPlace[] = [
    ...(demo ? [{ workspaceId: demo.workspaceId, name: demo.name, asOwner: true }] : []),
    ...me.workspaces
      .filter((w) => w.id !== demo?.workspaceId)
      .map((w) => ({ workspaceId: w.id, name: w.name, asOwner: false })),
  ];
  const scenes: DemoSceneSummary[] = DEMO_SCENES.map((s) => ({
    id: s.id,
    number: s.number,
    title: s.title,
    kind: s.kind,
    steps: s.steps.map(({ label, voiceover }) => ({ label, voiceover })),
    script: voiceoverScript(s),
  }));
  return (
    <DemoStart
      places={places}
      founder={founder}
      demoFound={!!demo}
      demoName={DEMO_BUSINESS}
      scenes={scenes}
    />
  );
}
