
import { randomInt, randomBytes } from 'node:crypto';

export const PRIZE_NAMES = Object.freeze([
  'Early 5',
  'Early 10',
  'Top Line',
  'Middle Line',
  'Bottom Line',
  'Full House'
]);

const COLUMN_RANGES = [
  [1, 9],
  [10, 19],
  [20, 29],
  [30, 39],
  [40, 49],
  [50, 59],
  [60, 69],
  [70, 79],
  [80, 90]
];

function shuffle(values) {
  const result = [...values];

  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

export function validateTicketGrid(grid) {
  if (
    !Array.isArray(grid) ||
    grid.length !== 3 ||
    grid.some(row => !Array.isArray(row) || row.length !== 9)
  ) {
    return false;
  }

  const seen = new Set();

  for (let r = 0; r < 3; r++) {
    let count = 0;

    for (let c = 0; c < 9; c++) {
      const value = grid[r][c];

      if (!Number.isInteger(value)) return false;
      if (value === 0) continue;

      const [min, max] = COLUMN_RANGES[c];

      if (value < min || value > max || seen.has(value)) {
        return false;
      }

      seen.add(value);
      count++;
    }

    if (count !== 5) return false;
  }

  for (let c = 0; c < 9; c++) {
    const values = grid
      .map(row => row[c])
      .filter(value => value !== 0);

    if (values.length < 1 || values.length > 3) {
      return false;
    }

    for (let i = 1; i < values.length; i++) {
      if (values[i] <= values[i - 1]) return false;
    }
  }

  return seen.size === 15;
}

export function generateTambolaTicketGrid() {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const grid = Array.from(
      { length: 3 },
      () => Array(9).fill(0)
    );

    const columnCounts = Array(9).fill(1);
    let remaining = 6;

    while (remaining > 0) {
      const available = columnCounts
        .map((count, index) => count < 3 ? index : -1)
        .filter(index => index !== -1);

      const column = available[randomInt(available.length)];
      columnCounts[column]++;
      remaining--;
    }

    const rowCounts = [0, 0, 0];
    let possible = true;

    const columnOrder = shuffle(
      Array.from({ length: 9 }, (_, index) => index)
    ).sort((a, b) => columnCounts[b] - columnCounts[a]);

    for (const column of columnOrder) {
      const count = columnCounts[column];
      const [min, max] = COLUMN_RANGES[column];

      const pool = Array.from(
        { length: max - min + 1 },
        (_, index) => min + index
      );

      const numbers = shuffle(pool)
        .slice(0, count)
        .sort((a, b) => a - b);

      const availableRows = shuffle([0, 1, 2])
        .filter(row => rowCounts[row] < 5)
        .sort((a, b) => rowCounts[a] - rowCounts[b]);

      if (availableRows.length < count) {
        possible = false;
        break;
      }

      const selectedRows = availableRows
        .slice(0, count)
        .sort((a, b) => a - b);

      selectedRows.forEach((row, index) => {
        grid[row][column] = numbers[index];
        rowCounts[row]++;
      });
    }

    if (possible && validateTicketGrid(grid)) {
      return grid;
    }
  }

  throw new Error('Unable to generate a valid Tambola ticket.');
}

export function createTicket(name = 'Ticket') {
  const safeName = String(name).trim().slice(0, 80) || 'Ticket';

  return {
    id: `TKT-${randomBytes(8).toString('hex').toUpperCase()}`,
    name: safeName,
    grid: generateTambolaTicketGrid(),
    daubed: Array.from(
      { length: 3 },
      () => Array(9).fill(false)
    )
  };
}

export function verifyPrizePattern(grid, calledNumbers, prizeName) {
  if (!validateTicketGrid(grid)) return false;
  if (!PRIZE_NAMES.includes(prizeName)) return false;

  if (!Array.isArray(calledNumbers)) return false;

  if (calledNumbers.some(
    number => !Number.isInteger(number) ||
      number < 1 || number > 90
  )) {
    return false;
  }

  const calledSet = new Set(calledNumbers);

  const isCalled = (row, column) => {
    const number = grid[row][column];
    return number > 0 && calledSet.has(number);
  };

  const countCalled = grid.flat()
    .filter(number => number > 0 && calledSet.has(number))
    .length;

  switch (prizeName) {
    case 'Early 5':
      return countCalled >= 5;

    case 'Early 10':
      return countCalled >= 10;

    case 'Top Line':
      return grid[0].every(
        (number, column) => number === 0 || isCalled(0, column)
      );

    case 'Middle Line':
      return grid[1].every(
        (number, column) => number === 0 || isCalled(1, column)
      );

    case 'Bottom Line':
      return grid[2].every(
        (number, column) => number === 0 || isCalled(2, column)
      );

    case 'Full House':
      return countCalled === 15;

    default:
      return false;
  }
}
