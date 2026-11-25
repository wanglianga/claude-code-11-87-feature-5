import { describe, expect, it } from 'vitest';
import { formatCoordinate, formatMeasure, roundToScale } from './format';
import { hmacSha256HexSync, sha256HexSync } from './sha256';

describe('字段精度与检出限纪律', () => {
  it('定点舍入消除浮点误差', () => {
    expect(roundToScale(12.04, 1)).toBe(12.0);
    expect(roundToScale(14.96, 1)).toBe(15.0);
    expect(roundToScale(8.62, 1)).toBe(8.6);
  });

  it('裂缝宽度保留 0.1mm：12.03→12.0，14.96→15.0', () => {
    const r1 = formatMeasure('crackWidthMm', 12.03);
    expect(r1.display).toBe('12.0 mm');
    const r2 = formatMeasure('crackWidthMm', 14.96);
    expect(r2.display).toBe('15.0 mm');
  });

  it('低于检出限必须先判定，输出 <0.1 而不是 0.0', () => {
    const low = formatMeasure('crackWidthMm', 0.04);
    expect(low.belowDetectionLimit).toBe(true);
    expect(low.display).toContain('<0.1');
    expect(low.display).not.toBe('0.0 mm');
    expect(low.value).toBeNull();

    // 临界值 0.1 不属于“低于”
    const edge = formatMeasure('crackWidthMm', 0.1);
    expect(edge.belowDetectionLimit).toBe(false);
    expect(edge.display).toBe('0.1 mm');
  });

  it('null 保留“未测量”语义，绝不显示为 0', () => {
    const n = formatMeasure('crackWidthMm', null);
    expect(n.display).toContain('未测量');
    expect(n.value).toBeNull();
  });

  it('坐标按 0.1m 契约投影', () => {
    const c = formatCoordinate({ x: 51230.46, y: 38821.74 })!;
    expect(c.x).toBe('51230.5');
    expect(c.y).toBe('38821.7');
    expect(c.display).toContain('m');
    expect(formatCoordinate(null)).toBeNull();
  });
});

describe('纯 TS SHA-256/HMAC 标准向量', () => {
  it('sha256("abc") 符合 NIST 向量', () => {
    expect(sha256HexSync('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('HMAC-SHA256 RFC4231 风格已知答案', () => {
    // RFC 4231 case 1: key=0x0b*20, data="Hi There"
    const key = String.fromCharCode(...Array(20).fill(0x0b));
    expect(hmacSha256HexSync(key, 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });
});
