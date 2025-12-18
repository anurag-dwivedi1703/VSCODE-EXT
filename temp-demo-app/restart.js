const { exec, spawn } = require('child_process');

const ports = [3000, 3001];

function getPids(port) {
    return new Promise((resolve, reject) => {
        exec(`netstat -ano | findstr :${port}`, (err, stdout, stderr) => {
            if (err) {
                // If findstr finds nothing, it returns exit code 1, which is treated as error by exec
                resolve([]);
                return;
            }
            const lines = stdout.trim().split('\n');
            const pids = lines.map(line => {
                const parts = line.trim().split(/\s+/);
                return parts[parts.length - 1];
            }).filter(pid => /^\d+$/.test(pid));
            resolve([...new Set(pids)]);
        });
    });
}

function killPid(pid) {
    return new Promise((resolve, reject) => {
        exec(`taskkill /F /PID ${pid}`, (err, stdout, stderr) => {
            // Ignore errors (e.g. process already gone)
            resolve();
        });
    });
}

async function restart() {
    console.log('Stopping existing servers...');
    for (const port of ports) {
        const pids = await getPids(port);
        for (const pid of pids) {
            if (pid != 0) { // Don't kill system idle process
                console.log(`Killing process ${pid} on port ${port}`);
                await killPid(pid);
            }
        }
    }

    // Wait a moment for ports to free up
    await new Promise(r => setTimeout(r, 1000));

    console.log('Starting servers...');

    const fs = require('fs');
    const out = fs.openSync('./server.log', 'a');
    const err = fs.openSync('./server.log', 'a');

    const backend = spawn('node', ['server.js'], {
        detached: true,
        stdio: ['ignore', out, err],
        shell: true
    });
    backend.unref();
    console.log('Backend started on port 3001');

    const frontend = spawn('node', ['frontend_server.js'], {
        detached: true,
        stdio: ['ignore', out, err],
        shell: true
    });
    frontend.unref();
    console.log('Frontend started on port 3000 (Logs in server.log)');
}

restart();
