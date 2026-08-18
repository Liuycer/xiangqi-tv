import { getPieceLabel } from './pieces'
import type { Move, PieceState, Player } from './types'

const RED_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'] as const

function formatNumber(player: Player, value: number): string {
  return player === 'red' ? RED_NUMERALS[value - 1] ?? String(value) : String(value)
}

function getFileNumber(player: Player, col: number): number {
  return player === 'red' ? 9 - col : col + 1
}

export function formatMoveNotation(piece: PieceState, move: Move): string {
  const label = getPieceLabel(piece.player, piece.type)
  const fromFile = formatNumber(piece.player, getFileNumber(piece.player, move.from.col))

  if (move.from.row === move.to.row) {
    const toFile = formatNumber(piece.player, getFileNumber(piece.player, move.to.col))
    return `${label}${fromFile}平${toFile}`
  }

  const movingForward = piece.player === 'red'
    ? move.to.row < move.from.row
    : move.to.row > move.from.row
  const direction = movingForward ? '进' : '退'
  const usesDestinationFile = piece.type === 'horse'
    || piece.type === 'elephant'
    || piece.type === 'advisor'
  const destination = usesDestinationFile
    ? getFileNumber(piece.player, move.to.col)
    : Math.abs(move.to.row - move.from.row)

  return `${label}${fromFile}${direction}${formatNumber(piece.player, destination)}`
}
