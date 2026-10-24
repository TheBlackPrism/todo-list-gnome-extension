// Serves FakeJoplinServer over HTTP with the Data API routes the extension
// uses, so the real libsoup client can be tested against it.
//
//   node tests/helpers/fakeJoplinServer.js [--port N] [--token T]
//
// prints "LISTENING <port>" once ready. Pairing requests (POST /auth) are
// approved on the third check. /__test/* endpoints let tests change notes
// "in Joplin".

import http from 'node:http';
import {pathToFileURL} from 'node:url';

import {FakeJoplinServer, HttpError} from './fakeJoplin.js';

const DEFAULT_FIELDS = ['id', 'parent_id', 'title', 'deleted_time'];

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (text.trim() === '') {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(text));
            } catch {
                reject(new HttpError(500, 'Invalid JSON'));
            }
        });
        request.on('error', reject);
    });
}

/**
 * @param {object} [options]
 * @param {string} [options.token]
 * @returns {{server: http.Server, joplin: FakeJoplinServer}}
 */
export function createFakeJoplinHttpServer({token = 'test-token'} = {}) {
    const joplin = new FakeJoplinServer({token});
    const pairings = new Map();

    const route = async (request, url) => {
        const query = Object.fromEntries(url.searchParams);
        const parts = url.pathname.split('/').filter(Boolean);
        const body = await readBody(request);
        const method = request.method;

        if (method === 'GET' && url.pathname === '/ping')
            return {text: 'JoplinClipperServer'};
        if (method === 'POST' && url.pathname === '/auth') {
            const authToken = `auth-${pairings.size + 1}`;
            pairings.set(authToken, 0);
            return {json: {auth_token: authToken}};
        }
        if (method === 'GET' && url.pathname === '/auth/check') {
            if (query.token !== undefined)
                return {json: {valid: query.token === joplin.token}};
            if (!pairings.has(query.auth_token))
                throw new HttpError(500, 'Invalid auth token');
            const checks = pairings.get(query.auth_token) + 1;
            pairings.set(query.auth_token, checks);
            return {json: checks >= 3
                ? {status: 'accepted', token: joplin.token}
                : {status: 'waiting'}};
        }
        if (parts[0] === '__test')
            return control(parts[1], body);

        if (!query.token)
            throw new HttpError(403, 'Missing "token" parameter');
        if (query.token !== joplin.token)
            throw new HttpError(403, 'Invalid "token" parameter');

        const page = {page: Number(query.page) || 1, limit: query.limit === undefined ? 100 : Number(query.limit)};
        const fields = query.fields
            ? query.fields.split(',').map(field => field.trim()).filter(Boolean)
            : undefined;

        if (parts[0] === 'folders') {
            if (parts.length === 1 && method === 'GET')
                return {json: joplin.listFolders(page)};
            if (parts.length === 1 && method === 'POST')
                return {json: joplin.createFolder(body ?? {})};
            if (parts.length === 2 && method === 'GET')
                return {json: joplin.getFolder(parts[1])};
            if (parts.length === 3 && parts[2] === 'notes' && method === 'GET') {
                return {json: joplin.listFolderNotes(parts[1], {
                    ...page,
                    fields: fields ?? DEFAULT_FIELDS,
                    orderBy: query.order_by || 'updated_time',
                    orderDir: query.order_dir || 'ASC',
                })};
            }
        }
        if (parts[0] === 'notes') {
            if (parts.length === 1 && method === 'POST')
                return {json: joplin.createNote(body ?? {})};
            if (parts.length === 2 && method === 'GET')
                return {json: joplin.getNote(parts[1], fields ?? DEFAULT_FIELDS)};
            if (parts.length === 2 && method === 'PUT')
                return {json: joplin.updateNote(parts[1], body ?? {})};
            if (parts.length === 2 && method === 'DELETE') {
                joplin.deleteNote(parts[1], {permanent: query.permanent === '1'});
                return {text: ''};
            }
        }
        throw new HttpError(404, 'Not Found');
    };

    const control = (action, body = {}) => {
        switch (action) {
        case 'edit':
            joplin.edit(body.id, body.patch, {updatedTime: body.updatedTime});
            return {json: joplin.notes.get(body.id)};
        case 'trash':
            joplin.trash(body.id);
            return {json: {}};
        case 'purge':
            joplin.purge(body.id);
            return {json: {}};
        case 'todos':
            return {json: joplin.todosIn(body.folderId)};
        default:
            throw new HttpError(404, 'Not Found');
        }
    };

    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        route(request, url).then(result => {
            if (result.json !== undefined) {
                response.writeHead(200, {'Content-Type': 'application/json'});
                response.end(JSON.stringify(result.json));
            } else {
                response.writeHead(200, {'Content-Type': 'text/plain'});
                response.end(result.text);
            }
        }).catch(error => {
            const status = error instanceof HttpError ? error.status : 500;
            response.writeHead(status, {'Content-Type': 'application/json'});
            response.end(JSON.stringify({error: `${error.message}: \n\nError: ${error.message}\n    at fake`}));
        });
    });
    return {server, joplin};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const argument = name => {
        const index = process.argv.indexOf(name);
        return index > 0 ? process.argv[index + 1] : undefined;
    };
    const {server} = createFakeJoplinHttpServer({token: argument('--token') ?? 'test-token'});
    server.listen(Number(argument('--port') ?? 0), '127.0.0.1', () => {
        process.stdout.write(`LISTENING ${server.address().port}\n`);
    });
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
