import http from 'node:http';
import handler from 'serve-handler';

const port = Number(process.env.PORT || 3000);

const server = http.createServer((request, response) => {
  return handler(request, response, {
    public: 'dist',
    cleanUrls: false
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`PharmaLink is serving dist on port ${port}`);
});
