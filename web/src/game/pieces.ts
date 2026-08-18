import type { PieceType, Player } from './types'

const PIECE_LABELS: Readonly<Record<Player, Readonly<Record<PieceType, string>>>> = {
  red: {
    general: '帥',
    advisor: '仕',
    elephant: '相',
    horse: '馬',
    rook: '車',
    cannon: '炮',
    soldier: '兵',
  },
  black: {
    general: '將',
    advisor: '士',
    elephant: '象',
    horse: '馬',
    rook: '車',
    cannon: '炮',
    soldier: '卒',
  },
}

export function getPieceLabel(player: Player, type: PieceType): string {
  return PIECE_LABELS[player][type]
}

