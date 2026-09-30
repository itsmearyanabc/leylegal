import { AdmissionGate } from './admission-gate';

describe('AdmissionGate', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('admits up to the limit at once', async () => {
    const gate = new AdmissionGate(2, 0, 1000);
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(gate.stats()).toMatchObject({ inFlight: 2, admitted: 2, refused: 0 });
  });

  it('refuses at once when the line is full', async () => {
    const gate = new AdmissionGate(1, 1, 1000);
    await gate.acquire();
    void gate.acquire(); // waits in line
    await expect(gate.acquire()).resolves.toBeNull();
    expect(gate.stats()).toMatchObject({ inFlight: 1, waiting: 1, refused: 1 });
  });

  it('hands a released slot straight to the next waiter', async () => {
    const gate = new AdmissionGate(1, 5, 1000);
    const first = (await gate.acquire())!;
    const second = gate.acquire();
    expect(gate.stats().waiting).toBe(1);

    first();
    await expect(second).resolves.toEqual(expect.any(Function));
    expect(gate.stats()).toMatchObject({ inFlight: 1, waiting: 0, admitted: 2 });
  });

  it('gives up on a waiter after the wait timeout', async () => {
    const gate = new AdmissionGate(1, 5, 1000);
    await gate.acquire();
    const waiting = gate.acquire();

    jest.advanceTimersByTime(1000);
    await expect(waiting).resolves.toBeNull();
    expect(gate.stats()).toMatchObject({ waiting: 0, timedOut: 1, refused: 1, inFlight: 1 });
  });

  it('skips a waiter whose client has gone, instead of giving it the slot', async () => {
    const gate = new AdmissionGate(1, 5, 1000);
    const first = (await gate.acquire())!;
    let gone = false;
    const leaver = gate.acquire(() => gone);
    const stayer = gate.acquire();

    gone = true;
    first();
    await expect(leaver).resolves.toBeNull();
    await expect(stayer).resolves.toEqual(expect.any(Function));
    expect(gate.stats()).toMatchObject({ inFlight: 1, waiting: 0 });
  });

  it('frees the slot when the last holder releases, and ignores a second release', async () => {
    const gate = new AdmissionGate(1, 0, 1000);
    const release = (await gate.acquire())!;
    release();
    release();
    expect(gate.stats().inFlight).toBe(0);
    await expect(gate.acquire()).resolves.not.toBeNull();
  });

  it('rejects a nonsensical limit', () => {
    expect(() => new AdmissionGate(0, 0, 1000)).toThrow();
  });
});
