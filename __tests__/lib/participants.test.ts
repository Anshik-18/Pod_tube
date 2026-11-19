import {
  isParticipantId,
  baseParticipant,
  isScreenTrack,
  sortParticipantIds,
  participantLabel,
  screenTrackId,
} from '@/lib/participants';

describe('participant ids', () => {
  it('accepts host, legacy guest, invited guests and their screen shares', () => {
    for (const id of ['host', 'guest', 'guest-ab12cd', 'guest-ab12cd34ef56', 'host.screen1', 'guest-ab12cd.screen12']) {
      expect(isParticipantId(id)).toBe(true);
    }
  });

  it('rejects anything that could escape a storage path or impersonate', () => {
    for (const id of ['', '../host', 'host/..', 'guest-AB12CD', 'guest-ab', 'admin', 'host.screen', 'host.screenx', 'guest-ab12cd/x', 42, null]) {
      expect(isParticipantId(id)).toBe(false);
    }
  });

  it('maps screen tracks to their owner', () => {
    expect(baseParticipant('guest-ab12cd.screen2')).toBe('guest-ab12cd');
    expect(baseParticipant('host')).toBe('host');
    expect(isScreenTrack(screenTrackId('host', 3))).toBe(true);
    expect(isScreenTrack('guest-ab12cd')).toBe(false);
  });

  it('orders host first, then guests, each camera before its screens', () => {
    expect(sortParticipantIds(['guest-bbbbbb.screen1', 'guest-aaaaaa', 'host.screen1', 'guest-bbbbbb', 'host'])).toEqual([
      'host',
      'host.screen1',
      'guest-aaaaaa',
      'guest-bbbbbb',
      'guest-bbbbbb.screen1',
    ]);
  });

  it('labels tracks with the names people used in the studio', () => {
    const names = { host: 'Hannah', 'guest-aaaaaa': 'Alice' };
    expect(participantLabel('guest-aaaaaa', names)).toBe('Alice');
    expect(participantLabel('guest-aaaaaa.screen1', names)).toBe('Alice — screen 1');
    expect(participantLabel('guest-zzzzzz', names)).toBe('Guest');
  });
});

describe('camera segments', () => {
  it('accepts rejoin segments and keeps them with their owner', () => {
    expect(isParticipantId('guest-ab12cd.part2')).toBe(true);
    expect(baseParticipant('guest-ab12cd.part2')).toBe('guest-ab12cd');
    expect(isScreenTrack('guest-ab12cd.part2')).toBe(false);
    expect(sortParticipantIds(['host.part10', 'host.screen1', 'host.part2', 'host'])).toEqual(['host', 'host.part2', 'host.part10', 'host.screen1']);
    expect(participantLabel('host.part2', { host: 'Hannah' })).toBe('Hannah — part 2');
  });
});
