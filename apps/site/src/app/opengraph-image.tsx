import { ImageResponse } from 'next/og';

/**
 * The picture that shows up when somebody pastes a HandsFreeOS link into a text, Slack or a post.
 *
 * Drawn here rather than shipped as a PNG so the wording only lives in one place. It uses the
 * system font on purpose: nothing is fetched at build time, so the build cannot fail for it.
 */
export const alt = 'HandsFreeOS — your business keeps answering while you are on the job';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#f9fafd',
        padding: 72,
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: '#2d69d8',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff',
            fontSize: 28,
            fontWeight: 700,
          }}
        >
          H
        </div>
        <div style={{ fontSize: 30, fontWeight: 700, color: '#191d25' }}>HandsFreeOS</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div
          style={{
            fontSize: 68,
            fontWeight: 700,
            color: '#191d25',
            lineHeight: 1.08,
            letterSpacing: -1.5,
            maxWidth: 940,
          }}
        >
          Your business keeps answering while you’re on the job.
        </div>
        <div style={{ fontSize: 30, color: '#5b616a', maxWidth: 900, lineHeight: 1.35 }}>
          Calls, texts, email, calendar, quotes and invoices in one place — with an AI teammate that
          answers new leads in seconds.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 26 }}>
        <div
          style={{
            background: '#2d69d8',
            color: '#ffffff',
            padding: '14px 28px',
            borderRadius: 12,
            fontWeight: 700,
          }}
        >
          Start free
        </div>
        <div style={{ color: '#676c75' }}>handsfreeos.com</div>
      </div>
    </div>,
    size,
  );
}
