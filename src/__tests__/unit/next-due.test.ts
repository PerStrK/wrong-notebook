import { describe, expect, it } from 'vitest';
import { pickNextDueId } from '@/lib/next-due';

describe('pickNextDueId', () => {
    it('队列为空时返回 null', () => {
        expect(pickNextDueId([], 'a')).toBeNull();
    });

    it('当前题在队列中间时取后一位', () => {
        expect(pickNextDueId(['a', 'b', 'c'], 'b')).toBe('c');
        expect(pickNextDueId(['a', 'b', 'c'], 'a')).toBe('b');
    });

    it('当前题在队列末位时返回 null', () => {
        expect(pickNextDueId(['a', 'b', 'c'], 'c')).toBeNull();
    });

    it('队列只有当前题时返回 null', () => {
        expect(pickNextDueId(['a'], 'a')).toBeNull();
    });

    it('当前题不在队列中时取队首', () => {
        expect(pickNextDueId(['a', 'b'], 'x')).toBe('a');
    });

    it('当前题不在队列且队列只有一个其他题时取该题', () => {
        expect(pickNextDueId(['b'], 'a')).toBe('b');
    });
});
