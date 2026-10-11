import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoViewerFromEnv, publicDemoViewer } from './demoViewer';

const NAMES = ['DEMO_MODE', 'DEMO_VIEWER_EMAIL', 'DEMO_VIEWER_PASSWORD'] as const;

describe('閲覧用アカウントの環境変数', () => {
  const original = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
  });

  afterEach(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it('メールアドレスとパスワードが両方あるときだけ資格情報になる（片方・空文字は null）', () => {
    expect(demoViewerFromEnv()).toBeNull();
    process.env.DEMO_VIEWER_EMAIL = 'viewer@example.com';
    expect(demoViewerFromEnv()).toBeNull();
    process.env.DEMO_VIEWER_PASSWORD = '';
    expect(demoViewerFromEnv()).toBeNull();
    process.env.DEMO_VIEWER_PASSWORD = 'public-demo-pass';
    expect(demoViewerFromEnv()).toEqual({ email: 'viewer@example.com', password: 'public-demo-pass' });
    delete process.env.DEMO_VIEWER_EMAIL;
    expect(demoViewerFromEnv()).toBeNull();
  });

  it('前後の空白・改行は取る（画面の表示と、Cron が書く値がずれないように）', () => {
    process.env.DEMO_VIEWER_EMAIL = ' viewer@example.com\n';
    process.env.DEMO_VIEWER_PASSWORD = 'public-demo-pass \n';
    expect(demoViewerFromEnv()).toEqual({ email: 'viewer@example.com', password: 'public-demo-pass' });
    process.env.DEMO_VIEWER_PASSWORD = '  \n';
    expect(demoViewerFromEnv()).toBeNull();
  });

  it('ログイン画面に載せるのは DEMO_MODE=1 のときだけ（環境変数があっても、デモでなければ載せない）', () => {
    process.env.DEMO_VIEWER_EMAIL = 'viewer@example.com';
    process.env.DEMO_VIEWER_PASSWORD = 'public-demo-pass';
    expect(publicDemoViewer()).toBeNull();
    process.env.DEMO_MODE = 'true';
    expect(publicDemoViewer()).toBeNull();
    process.env.DEMO_MODE = '1';
    expect(publicDemoViewer()).toEqual({ email: 'viewer@example.com', password: 'public-demo-pass' });
    delete process.env.DEMO_VIEWER_PASSWORD;
    expect(publicDemoViewer()).toBeNull();
  });
});
