'use strict'
window.renderOffscreenPov = (snapshot) => {
  const canvas = document.getElementById('pov')
  const small = document.createElement('canvas')
  small.width = 256; small.height = 144
  const frame = new window.afkVoxelRenderer.VoxelRenderer().render(snapshot, small.width, small.height)
  small.getContext('2d').putImageData(new ImageData(frame.data, small.width, small.height), 0, 0)
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = false
  context.drawImage(small, 0, 0, canvas.width, canvas.height)
  const x = canvas.width / 2, y = canvas.height / 2
  context.strokeStyle = '#ffffffdd'; context.beginPath()
  context.moveTo(x - 6, y); context.lineTo(x + 6, y)
  context.moveTo(x, y - 6); context.lineTo(x, y + 6); context.stroke()
  return canvas.toDataURL('image/png')
}
