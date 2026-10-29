/* eslint-disable no-console -- CI fixture emits synthetic diagnostic evidence only. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PG_IMAGE = 'mirror.gcr.io/library/postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const NODE_IMAGE = 'node:24-bookworm-slim@sha256:e1582112fb9f152ed38eefcd712efc93fee1becb519fdfa57574d5e07eaa5e7d';
const TEST = 'src/libs/billing/topupReconciliation.cursor.integration.test.ts';
const COUNT = 18;
const ROLE = 'cursor_ci_fixture';
const DATA = '/var/lib/postgresql/data/owned';

function command(args, timeout = 30000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    throw new Error(`CURSOR_FIXTURE_DOCKER_FAILED: ${args[0]}`);
  }
  return result.stdout.trim();
}

export function readBoundedCursorJson(file, maximumBytes) {
  assert.ok(Number.isInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 1048576);
  // Anchor the actual object, reject symlinks, and never block opening a FIFO.
  // The size check is advisory; the fd read itself is capped even if it grows.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= maximumBytes);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) {
        break;
      }
      bytes += count;
    }
    assert.ok(bytes <= maximumBytes);
    return JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

export function quiesceOwnedCursorTest(id, owner, call = command) {
  assert.match(id, /^[a-f0-9]{64}$/);
  const inspect = () => {
    const value = JSON.parse(call(['inspect', id]))[0];
    assert.equal(value.Id, id);
    assert.equal(value.Config.Labels['luster-cursor-owner'], owner);
    return value;
  };
  const initial = inspect();
  if (initial.State.Running || initial.State.Restarting) {
    try {
      call(['stop', '--time', '5', id], 15000);
    } catch {
      call(['kill', id], 15000);
    }
  }
  const final = inspect();
  assert.equal(final.State.Running, false);
  assert.equal(final.State.Restarting, false);
  assert.equal(final.State.Pid, 0);
  return final.State.ExitCode;
}

export function requireCursorResults(result) {
  assert.equal(result.success, true);
  assert.equal(result.numTotalTests, COUNT);
  assert.equal(result.numPassedTests, COUNT);
  assert.equal(result.numPendingTests, 0);
  assert.equal(result.numFailedTests, 0);
  assert.equal(result.testResults.length, 1);
  assert.equal(result.testResults[0].assertionResults.length, COUNT);
  assert.ok(result.testResults[0].assertionResults.every(test => test.status === 'passed'));
}

export function waitForFinalPostgres(probe, pause) {
  let consecutive = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    consecutive = probe() ? consecutive + 1 : 0;
    if (consecutive === 2) {
      return;
    }
    pause();
  }
  throw new Error('CURSOR_FINAL_POSTGRES_NOT_READY');
}

export function projectCursorIdentity(identity, database) {
  assert.deepEqual({ ...identity, version: undefined }, { db: database, session_user: ROLE, current_user: ROLE, address: null, port: '5432', listen: '', data: DATA, version: undefined });
  assert.equal(Math.floor(Number(identity.version) / 10000), 16);
  return { database, role: ROLE, address: null, port: 5432, listen: '', dataDirectory: DATA, versionMajor: 16 };
}

export function projectCursorResult(result) {
  const projection = {};
  for (const key of ['numTotalTests', 'numPassedTests', 'numPendingTests', 'numFailedTests']) {
    assert.ok(Number.isInteger(result[key]) && result[key] >= 0 && result[key] <= 1000);
    projection[key] = result[key];
  }
  assert.equal(typeof result.success, 'boolean');
  return { success: result.success, ...projection };
}

export function projectPgDiagnostics(text) {
  const tail = typeof text === 'string' ? text.slice(-16384) : '';
  return {
    readyMessages: (tail.match(/database system is ready to accept connections/g) ?? []).length,
    shutdownMessages: (tail.match(/database system is shut down/g) ?? []).length,
    fatalMessages: (tail.match(/FATAL:/g) ?? []).length,
    errorMessages: (tail.match(/ERROR:/g) ?? []).length,
    rawLogRetained: false,
  };
}

export function runCursorPostgres() {
  assert.equal(process.platform, 'linux', 'CI runner requires Linux Docker isolation');
  assert.equal(process.arch, 'x64', 'Image pins target Linux/amd64');
  const subject = process.cwd();
  assert.ok(lstatSync(path.join(subject, '.git')).isDirectory(), 'CI checkout requires ordinary Git metadata before masking');
  const root = mkdtempSync(path.join(tmpdir(), 'topup-cursor-ci-'));
  const socket = path.join(root, 'socket');
  const artifacts = path.join(root, 'artifacts');
  const owner = `cursor-${randomUUID()}`;
  const database = `topup_reconcile_fixture_${randomUUID().replaceAll('-', '')}`;
  const owned = [];
  let cleanupFailed = false;
  const report = { status: 'blocked', phase: 'setup', expectedTests: COUNT, identity: null, result: null, pgDiagnostics: null, cleanupVerified: false, rawStreamsRetained: false };
  const evidencePath = path.join(process.env.RUNNER_TEMP || tmpdir(), 'topup-cursor-postgres-summary.json');
  let postgresId;
  let evidenceWritten = false;
  let evidenceFailed = false;
  const saveEvidence = () => {
    const serialized = `${JSON.stringify(report)}\n`;
    assert.ok(Buffer.byteLength(serialized) <= 16384);
    if (!evidenceWritten) {
      writeFileSync(evidencePath, serialized, { flag: 'wx', mode: 0o600 });
      evidenceWritten = true;
    } else {
      const pending = `${evidencePath}.${owner}.pending`;
      writeFileSync(pending, serialized, { flag: 'wx', mode: 0o600 });
      renameSync(pending, evidencePath);
    }
  };
  // No shared database or caller-supplied URL/socket is accepted.
  chmodSync(root, 0o755);
  const mkdir = spawnSync('mkdir', ['-m', '0777', socket, artifacts]);
  assert.equal(mkdir.status, 0);
  const common = ['--label', `luster-cursor-owner=${owner}`, '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=384m', '--memory-swap=384m', '--cpus=2', '--pids-limit=128'];
  try {
    command(['version', '--format', '{{.Server.Version}}']);
    for (const image of [PG_IMAGE, NODE_IMAGE]) {
      command(['pull', image], 120000);
    }
    const pgid = command(['create', '--cidfile', path.join(root, 'pg.cid'), ...common, '--user=postgres', '--read-only', '--tmpfs', '/tmp:rw', '--tmpfs', '/var/run/postgresql:rw,mode=1777', '--tmpfs', '/var/lib/postgresql/data:rw,mode=1777', '--mount', `type=bind,src=${socket},dst=${socket}`, '-e', `PGDATA=${DATA}`, '-e', `POSTGRES_USER=${ROLE}`, '-e', `POSTGRES_DB=${database}`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', PG_IMAGE, 'postgres', '-h', '', '-p', '5432', '-c', `unix_socket_directories=${socket},/var/run/postgresql`, '-c', 'unix_socket_permissions=0777']);
    assert.match(pgid, /^[a-f0-9]{64}$/);
    owned.push(pgid);
    postgresId = pgid;
    const inspect = JSON.parse(command(['inspect', pgid]))[0];
    assert.equal(inspect.Id, pgid);
    assert.equal(inspect.Config.Image, PG_IMAGE);
    assert.equal(inspect.Config.Labels['luster-cursor-owner'], owner);
    assert.equal(inspect.HostConfig.NetworkMode, 'none');
    assert.equal(inspect.HostConfig.Privileged, false);
    assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
    assert.deepEqual(inspect.Mounts.filter(mount => mount.Type === 'bind').map(mount => [mount.Source, mount.Destination]), [[socket, socket]]);
    command(['start', pgid]);
    // The official image starts a temporary accepting server during initdb.
    // Only its final exec replaces PID 1 with postgres. Require two stable
    // final-process observations, then independently attest the live session.
    waitForFinalPostgres(() => {
      const probe = spawnSync('docker', ['exec', pgid, 'sh', '-ec', 'test "$(cat /proc/1/comm)" = postgres; exec pg_isready "$@"', 'cursor-readiness', '-h', socket, '-p', '5432', '-U', ROLE, '-d', database], { timeout: 5000, stdio: 'ignore' });
      return probe.status === 0;
    }, () => spawnSync('sleep', ['0.5'], { timeout: 1000 }));
    report.phase = 'final-server-ready';
    // The original suite wraps Socket.connect itself. Its underlying original
    // remains this stricter exact-path fence, including after its afterAll.
    writeFileSync(path.join(artifacts, 'fence.cjs'), `const net=require('node:net');const exact=${JSON.stringify(path.join(socket, '.s.PGSQL.5432'))};const original=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){let first=args[0];if(Array.isArray(first))first=first[0];if((typeof first==='string'?first:first?.path)!==exact)throw Error('CURSOR_IP_TRANSPORT_FORBIDDEN');return original.apply(this,args)};const deny=()=>{throw Error('CURSOR_PROVIDER_TRANSPORT_FORBIDDEN')};global.fetch=deny;for(const mod of ['node:http','node:https']){const m=require(mod);m.request=deny;m.get=deny}require('node:tls').connect=deny;require('node:dgram').createSocket=deny;const dns=require('node:dns');for(const k of ['lookup','resolve','resolve4','resolve6'])dns[k]=deny;`);
    const config = { root: '/subject', cacheDir: path.join(artifacts, 'cache'), resolve: { alias: { '@': '/subject/src' } }, test: { include: [TEST], environment: 'node', fileParallelism: false, maxWorkers: 1, testTimeout: 20000, hookTimeout: 30000, reporters: ['verbose', 'json'], outputFile: { json: path.join(artifacts, 'results.json') } } };
    writeFileSync(path.join(artifacts, 'vitest.config.mjs'), `export default ${JSON.stringify(config)};`);
    writeFileSync(path.join(artifacts, 'bootstrap.cjs'), `const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const requireSubject=require('node:module').createRequire('/subject/package.json');const pg=requireSubject('pg');const socket=${JSON.stringify(socket)},database=${JSON.stringify(database)};assert.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);assert.equal(fs.statSync(path.join(socket,'.s.PGSQL.5432')).isSocket(),true);assert.equal(fs.realpathSync(socket),socket);const client=new pg.Client({host:socket,port:5432,user:${JSON.stringify(ROLE)},database,connectionTimeoutMillis:3000});(async()=>{try{await client.connect();const identity=(await client.query("SELECT current_database() AS db,session_user AS session_user,current_user AS current_user,inet_server_addr() AS address,current_setting('port') AS port,current_setting('listen_addresses') AS listen,current_setting('data_directory') AS data,current_setting('server_version_num') AS version")).rows[0];assert.deepEqual({...identity,version:undefined},{db:database,session_user:${JSON.stringify(ROLE)},current_user:${JSON.stringify(ROLE)},address:null,port:'5432',listen:'',data:${JSON.stringify(DATA)},version:undefined});assert.equal(Math.floor(Number(identity.version)/10000),16);fs.writeFileSync(${JSON.stringify(path.join(artifacts, 'identity.json'))},JSON.stringify(identity));}finally{await client.end()}const result=require('node:child_process').spawnSync(process.execPath,['--max-old-space-size=192','/subject/node_modules/vitest/vitest.mjs','run','--config',${JSON.stringify(path.join(artifacts, 'vitest.config.mjs'))}],{cwd:'/subject',env:process.env,stdio:'inherit',timeout:120000});process.exitCode=result.status===0&&!result.error?0:1;})().catch(()=>{console.error('CURSOR_OWNED_IDENTITY_REJECTED');process.exitCode=1});`);
    const testid = command(['create', '--cidfile', path.join(root, 'test.cid'), ...common, '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--tmpfs', '/tmp:rw', '--tmpfs', '/subject/.git:ro,noexec,nosuid,nodev,mode=000', '--mount', `type=bind,src=${subject},dst=/subject,readonly`, '--mount', `type=bind,src=${socket},dst=${socket},readonly`, '--mount', `type=bind,src=${artifacts},dst=${artifacts}`, '-w', '/subject', '-e', `USER=${ROLE}`, '-e', 'HOME=/tmp', '-e', 'CI=true', '-e', 'NODE_ENV=test', '-e', `TOPUP_CURSOR_TEST_SOCKET=${socket}`, '-e', `TOPUP_CURSOR_TEST_DATABASE=${database}`, '-e', 'TOPUP_CURSOR_DISPOSABLE_DATABASE_CONFIRMED=true', '-e', `NODE_OPTIONS=--require=${path.join(artifacts, 'fence.cjs')} --max-old-space-size=192`, NODE_IMAGE, 'node', path.join(artifacts, 'bootstrap.cjs')]);
    assert.match(testid, /^[a-f0-9]{64}$/);
    owned.push(testid);
    const testInspect = JSON.parse(command(['inspect', testid]))[0];
    assert.equal(testInspect.HostConfig.NetworkMode, 'none');
    assert.equal(testInspect.Config.Image, NODE_IMAGE);
    report.phase = 'test-execution';
    const execution = spawnSync('docker', ['start', '-a', testid], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    // docker start/attach may time out while the container keeps writing.
    // Evaluate errors first and quiesce the exact owned producer on EVERY path
    // before opening artifacts; never inspect a still-active writer's files.
    const executionFailed = Boolean(execution.error) || execution.status !== 0;
    const finalExitCode = quiesceOwnedCursorTest(testid, owner);
    if (existsSync(path.join(artifacts, 'identity.json'))) {
      report.identity = projectCursorIdentity(readBoundedCursorJson(path.join(artifacts, 'identity.json'), 4096), database);
    }
    if (existsSync(path.join(artifacts, 'results.json'))) {
      report.result = projectCursorResult(readBoundedCursorJson(path.join(artifacts, 'results.json'), 1048576));
    }
    assert.equal(executionFailed, false);
    assert.equal(finalExitCode, 0);
    requireCursorResults(readBoundedCursorJson(path.join(artifacts, 'results.json'), 1048576));
    report.status = 'passed';
    report.phase = 'complete';
    console.log('TOPUP_CURSOR_POSTGRES_TESTS_EXECUTED=18 TOPUP_CURSOR_POSTGRES_TESTS_SKIPPED=0');
  } finally {
    // Project bounded PostgreSQL diagnostics BEFORE teardown, including failed
    // startup. Never persist raw logs, SQL, child stdout/stderr or credentials.
    if (postgresId) {
      try {
        const identity = JSON.parse(command(['inspect', postgresId]))[0];
        assert.equal(identity.Config.Labels['luster-cursor-owner'], owner);
        const logs = spawnSync('docker', ['logs', '--tail', '30', postgresId], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
        report.pgDiagnostics = projectPgDiagnostics(`${logs.stdout ?? ''}\n${logs.stderr ?? ''}`);
      } catch {
        report.pgDiagnostics = { unavailable: true, rawLogRetained: false };
      }
    }
    const testsPassed = report.status === 'passed';
    report.status = testsPassed ? 'pending-cleanup' : 'blocked';
    try {
      saveEvidence();
    } catch {
      evidenceFailed = true;
      console.error('CURSOR_SAFE_EVIDENCE_WRITE_FAILED');
    }
    // Only exact IDs with our random owner label may be stopped or removed.
    // Runner SIGKILL/cancellation may bypass finally; job/container isolation
    // does not establish crash durability or guarantee forced-kill cleanup.
    // A create timeout may still have written its CID; recover only exact
    // locally recorded IDs, then attest the label before any cleanup action.
    for (const name of ['pg.cid', 'test.cid']) {
      const cidfile = path.join(root, name);
      if (existsSync(cidfile)) {
        const id = readFileSync(cidfile, 'utf8').trim();
        if (/^[a-f0-9]{64}$/.test(id) && !owned.includes(id)) {
          owned.push(id);
        }
      }
    }
    for (const id of owned.toReversed()) {
      try {
        const inspected = JSON.parse(command(['inspect', id]))[0];
        assert.equal(inspected.Config.Labels['luster-cursor-owner'], owner);
        try {
          command(['stop', '--time', '5', id], 15000);
        } catch {
          cleanupFailed = true;
          console.error('CURSOR_FIXTURE_GRACEFUL_STOP_FAILED');
        }
        command(['rm', '-f', id], 15000);
        const remaining = command(['ps', '-aq', '--no-trunc']).split('\n');
        assert.ok(!remaining.includes(id));
      } catch {
        cleanupFailed = true;
      }
    }
    if (!cleanupFailed) {
      rmSync(root, { recursive: true, force: true });
    }
    report.cleanupVerified = !cleanupFailed;
    report.status = testsPassed && !cleanupFailed && !evidenceFailed ? 'passed' : 'blocked';
    if (evidenceWritten && !evidenceFailed) {
      try {
        saveEvidence();
      } catch {
        evidenceFailed = true;
      }
    }
    console.log(JSON.stringify(report));
    assert.equal(evidenceFailed, false, 'CURSOR_SAFE_EVIDENCE_WRITE_FAILED');
    assert.equal(cleanupFailed, false, 'CURSOR_OWNED_CLEANUP_FAILED');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCursorPostgres();
  } catch {
    console.error('CURSOR_POSTGRES_REQUIRED_FAILED');
    process.exitCode = 1;
  }
}
