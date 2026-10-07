import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from './signature';

const SECRET = 'test-channel-secret';

function sign(body: string | Uint8Array, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

describe('verifySignature', () => {
  const body = JSON.stringify({ destination: 'U1', events: [{ type: 'message', text: 'こんにちは' }] });

  it('正しい署名は通る', () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('日本語を含むボディも、文字列・バイト列のどちらでも通る', () => {
    const bytes = new TextEncoder().encode(body);
    expect(verifySignature(bytes, sign(bytes), SECRET)).toBe(true);
    expect(verifySignature(body, sign(bytes), SECRET)).toBe(true);
  });

  it('ボディを1文字でも変えると落ちる', () => {
    expect(verifySignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifySignature(body.replace('こんにちは', 'こんばんは'), sign(body), SECRET)).toBe(false);
  });

  it('JSON を整形し直したボディでは落ちる（加工前のボディで検証する）', () => {
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifySignature(reformatted, sign(body), SECRET)).toBe(false);
  });

  it('別のシークレットで作った署名は落ちる', () => {
    expect(verifySignature(body, sign(body, 'other-secret'), SECRET)).toBe(false);
  });

  it('署名が null・空・長さ違い・base64 でない文字列でも例外にせず false', () => {
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, '', SECRET)).toBe(false);
    expect(verifySignature(body, 'short', SECRET)).toBe(false);
    expect(verifySignature(body, `${sign(body)}AAAA`, SECRET)).toBe(false);
    expect(verifySignature(body, '!!!not base64!!!', SECRET)).toBe(false);
  });

  it('シークレットが空なら false（署名が空シークレットで作られていても通さない）', () => {
    expect(verifySignature(body, sign(body, ''), '')).toBe(false);
  });

  it('空のボディでも署名が合えば通る', () => {
    expect(verifySignature('', sign(''), SECRET)).toBe(true);
  });
});
