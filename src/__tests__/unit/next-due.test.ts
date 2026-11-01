import { describe, expect, it } from 'vitest';
import { pickDueNeighbors, pickNextDueId } from '@/lib/next-due';

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

describe('pickDueNeighbors', () => {
    it('首题没有上一题，下一题为第二题', () => {
        expect(pickDueNeighbors(['a', 'b', 'c'], 'a')).toEqual({
            prevId: null,
            nextId: 'b',
            index: 0,
            total: 3,
        });
    });

    it('末题没有下一题，上一题为倒数第二题', () => {
        expect(pickDueNeighbors(['a', 'b', 'c'], 'c')).toEqual({
            prevId: 'b',
            nextId: null,
            index: 2,
            total: 3,
        });
    });

    it('中间题同时有上一题和下一题', () => {
        expect(pickDueNeighbors(['a', 'b', 'c'], 'b')).toEqual({
            prevId: 'a',
            nextId: 'c',
            index: 1,
            total: 3,
        });
    });

    it('单题队列既没有上一题也没有下一题', () => {
        expect(pickDueNeighbors(['a'], 'a')).toEqual({
            prevId: null,
            nextId: null,
            index: 0,
            total: 1,
        });
    });

    it('当前题不在队列中时返回 null', () => {
        expect(pickDueNeighbors(['a', 'b'], 'x')).toBeNull();
    });

    it('队列为空时返回 null', () => {
        expect(pickDueNeighbors([], 'a')).toBeNull();
    });
});
