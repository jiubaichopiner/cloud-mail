import http from 'node:http'

let hits = []
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/hits') return res.end(JSON.stringify(hits))
  hits.push(req.url)
  res.end(JSON.stringify({ok: true}))
}).listen(3218, '127.0.0.1', () => console.log('Privacy test collector: http://127.0.0.1:3218'))
