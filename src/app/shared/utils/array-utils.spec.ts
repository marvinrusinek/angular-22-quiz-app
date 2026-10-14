import { ArrayUtils } from './array-utils';

describe('ArrayUtils', () => {
  describe('shuffleArray', () => {
    it('should return the same array reference (in-place)', () => {
      const arr = [1, 2, 3, 4, 5];
      const result = ArrayUtils.shuffleArray(arr);
      expect(result).toBe(arr);
    });

    it('should preserve all elements', () => {
      const arr = [1, 2, 3, 4, 5];
      expect(arr.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('should preserve array length', () => {
      const arr = [10, 20, 30];
      ArrayUtils.shuffleArray(arr);
      expect(arr.length).toBe(3);
    });

    it('should handle empty array', () => {
      const arr: number[] = [];
      const result = ArrayUtils.shuffleArray(arr);
      expect(result).toEqual([]);
    });

    it('should handle single element array', () => {
      const arr = [42];
      const result = ArrayUtils.shuffleArray(arr);
      expect(result).toEqual([42]);
    });

    it('should handle array of strings', () => {
      const arr = ['a', 'b', 'c', 'd'];
      ArrayUtils.shuffleArray(arr);
      expect(arr.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('should eventually produce a different order (statistical)', () => {
      const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      let differentOrderSeen = false;

      for (let attempt = 0; attempt < 20; attempt++) {
        const copy = [...original];
        ArrayUtils.shuffleArray(copy);
        if (copy.some((val, idx) => val !== original[idx])) {
          differentOrderSeen = true;
          break;
        }
      }

      expect(differentOrderSeen).toBe(true);
    });
  });
});
