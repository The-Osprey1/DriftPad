// Benchmark script for Conway's Game of Life (16x32 grid)

// Baseline implementation (2D boolean array with map and slice clones)
function baselineLifeStep(grid: boolean[][]): boolean[][] {
  const next = grid.map((row) => [...row]);
  for (let r = 0; r < 16; r++) {
    for (let col = 0; col < 32; col++) {
      let neighbors = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = (r + dr + 16) % 16;
          const nc = (col + dc + 32) % 32;
          if (grid[nr][nc]) neighbors++;
        }
      }
      if (grid[r][col] && (neighbors === 2 || neighbors === 3)) {
        next[r][col] = true;
      } else if (!grid[r][col] && neighbors === 3) {
        next[r][col] = true;
      } else {
        next[r][col] = false;
      }
    }
  }
  return next;
}

// Optimized implementation (1D Uint8Array with double buffering and bitwise wrapping)
function optimizedLifeStep(currentGrid: Uint8Array, nextGrid: Uint8Array): void {
  for (let r = 0; r < 16; r++) {
    const rowOffset = r << 5;
    const rAbove = ((r - 1 + 16) & 15) << 5;
    const rBelow = ((r + 1) & 15) << 5;

    for (let col = 0; col < 32; col++) {
      const cLeft = (col - 1 + 32) & 31;
      const cRight = (col + 1) & 31;

      const neighbors =
        currentGrid[rAbove + cLeft] +
        currentGrid[rAbove + col] +
        currentGrid[rAbove + cRight] +
        currentGrid[rowOffset + cLeft] +
        currentGrid[rowOffset + cRight] +
        currentGrid[rBelow + cLeft] +
        currentGrid[rBelow + col] +
        currentGrid[rBelow + cRight];

      const idx = rowOffset + col;
      const cell = currentGrid[idx];
      nextGrid[idx] = (cell === 1 && (neighbors === 2 || neighbors === 3)) || (cell === 0 && neighbors === 3) ? 1 : 0;
    }
  }
}

// Run benchmarks
function runBenchmark() {
  const ITERATIONS = 100_000;

  // Initialize baseline grid
  // Deterministic seed
  let baselineGrid: boolean[][] = Array.from({ length: 16 }, (_, r) =>
    Array.from({ length: 32 }, (_, c) => (r * 31 + c) % 3 === 0)
  );

  // Measure Baseline
  const baselineStart = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    baselineGrid = baselineLifeStep(baselineGrid);
  }
  const baselineEnd = performance.now();
  const baselineDurationMs = baselineEnd - baselineStart;

  // Initialize optimized grids
  let currentOptGrid = new Uint8Array(512);
  let nextOptGrid = new Uint8Array(512);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 32; c++) {
      currentOptGrid[(r << 5) | c] = (r * 31 + c) % 3 === 0 ? 1 : 0;
    }
  }

  // Measure Optimized
  const optStart = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    optimizedLifeStep(currentOptGrid, nextOptGrid);
    // Swap references
    const temp = currentOptGrid;
    currentOptGrid = nextOptGrid;
    nextOptGrid = temp;
  }
  const optEnd = performance.now();
  const optDurationMs = optEnd - optStart;

  console.log(`=== CONWAY'S GAME OF LIFE BENCHMARK (${ITERATIONS.toLocaleString()} iterations) ===`);
  console.log(`Baseline (2D Array + Allocations): ${baselineDurationMs.toFixed(2)} ms (${(ITERATIONS / (baselineDurationMs / 1000)).toFixed(0)} ops/sec)`);
  console.log(`Optimized (1D Uint8Array + Flat Loops): ${optDurationMs.toFixed(2)} ms (${(ITERATIONS / (optDurationMs / 1000)).toFixed(0)} ops/sec)`);
  console.log(`Speedup: ${(baselineDurationMs / optDurationMs).toFixed(2)}x faster`);
  console.log(`Latency reduction: ${((1 - optDurationMs / baselineDurationMs) * 100).toFixed(2)}%`);
}

runBenchmark();
