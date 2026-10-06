<?php
declare(strict_types=1);
namespace OCA\WorkspaceStorage\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\JSONResponse;
use OCP\Files\IRootFolder;
use OCP\Http\Client\IClientService;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserSession;

// Endpoints deliberately retain Nextcloud's admin and CSRF checks. The rclone
// credential remains server-side; arbitrary RC operations are never forwarded.
class WorkspaceController extends Controller {
    public function __construct(IRequest $request, private IRootFolder $root,
        private IUserSession $session, private IConfig $config, private IClientService $http) {
        parent::__construct('workspace_storage', $request);
    }

    // rclone's own error messages, such as a refused pin, are thrown as
    // DomainException so they can be shown to the user.
    private function remote(string $call, array $data): array {
        $password = $this->config->getAppValue('workspace_storage', 'rc_password', '');
        if ($password === '') { throw new \RuntimeException('Workspace service is not configured'); }
        $response = $this->http->newClient()->post('http://127.0.0.1:8687/vfs/' . $call, [
            'auth' => ['workspace', $password],
            'json' => ['fs' => 'workspace:'] + $data,
            'timeout' => 30,
            'http_errors' => false,
            'nextcloud' => ['allow_local_address' => true],
        ]);
        $body = json_decode((string)$response->getBody(), true, 512, JSON_THROW_ON_ERROR);
        if ($response->getStatusCode() !== 200) {
            throw new \DomainException($body['error'] ?? 'Workspace service error');
        }
        return $body;
    }

    private function workspacePath(string $id): string {
        if (!ctype_digit($id)) { throw new \RuntimeException('Invalid file ID'); }
        $user = $this->session->getUser();
        if ($user === null) { throw new \RuntimeException('Login required'); }
        $folder = $this->root->getUserFolder($user->getUID());
        $mount = $folder->get('workspace');
        $prefix = rtrim($mount->getPath(), '/');
        foreach ($folder->getById($id) as $node) {
            $path = $node->getPath();
            if (($path === $prefix || str_starts_with($path, $prefix . '/'))
                && $node->getStorage()->getId() === $mount->getStorage()->getId()
                && $node->isReadable()) {
                return ltrim(substr($path, strlen($prefix)), '/');
            }
        }
        throw new \RuntimeException('File is outside your workspace');
    }

    // Asks rclone once per parent directory, as vfs/status lists a directory.
    public function status(array $ids = []): JSONResponse {
        if (count($ids) > 100) { return new JSONResponse(['error' => 'Too many files'], 400); }
        $byDir = [];
        $files = [];
        foreach (array_unique($ids) as $id) {
            try { $path = $this->workspacePath((string)$id); }
            catch (\Throwable) { $files[$id] = ['error' => 'Storage status unavailable']; continue; }
            $slash = strrpos($path, '/');
            $byDir[$slash === false ? '' : substr($path, 0, $slash)][] = [$id, substr($path, $slash === false ? 0 : $slash + 1)];
        }
        $budget = -1;
        foreach ($byDir as $dir => $entries) {
            try {
                $listing = $this->remote('status', ['path' => (string)$dir]);
                $budget = $listing['pin_budget_left'];
                $byName = array_column($listing['files'], null, 'name');
                foreach ($entries as [$id, $name]) { $files[$id] = $byName[$name] ?? ['error' => 'Storage status unavailable']; }
            } catch (\Throwable) {
                foreach ($entries as [$id]) { $files[$id] = ['error' => 'Storage status unavailable']; }
            }
        }
        return new JSONResponse(['files' => (object)$files, 'budget' => $budget]);
    }

    public function action(array $ids, string $action): JSONResponse {
        if (!in_array($action, ['pin', 'unpin', 'cold', 'retry'], true)) {
            return new JSONResponse(['error' => 'Unknown action'], 400);
        }
        if (count($ids) === 0 || count($ids) > 100) { return new JSONResponse(['error' => 'Select 1 to 100 files'], 400); }
        try {
            $paths = array_map(fn($id) => $this->workspacePath((string)$id), array_values(array_unique($ids)));
            if ($action === 'pin' || $action === 'unpin') {
                // One call so a multi-selection is pinned all or nothing.
                $this->remote('pin', ['paths' => $paths, 'mode' => $action === 'pin' ? 'pinned' : 'unpinned']);
                return new JSONResponse(['skipped' => []]);
            }
            $skipped = [];
            foreach ($paths as $path) {
                $result = $this->remote($action === 'cold' ? 'evict' : 'retry', ['path' => $path]);
                array_push($skipped, ...($result['skipped'] ?? []));
            }
            return new JSONResponse(['skipped' => $skipped]);
        }
        catch (\DomainException $e) { return new JSONResponse(['error' => $this->friendly($e->getMessage())], 400); }
        catch (\Throwable) { return new JSONResponse(['error' => 'Could not reach workspace storage'], 503); }
    }

    private function friendly(string $error): string {
        if (preg_match('/would use (\S+), exceeding --vfs-cache-max-size of (\S+)/', $error, $m)) {
            return "Not enough local space, this would use $m[1] of the $m[2] limit";
        }
        if (str_contains($error, 'file does not exist')) { return 'File no longer exists'; }
        return $error;
    }
}
