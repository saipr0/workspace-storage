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

    private function remote(array $data): array {
        $password = $this->config->getAppValue('workspace_storage', 'rc_password', '');
        if ($password === '') { throw new \RuntimeException('Workspace service is not configured'); }
        $response = $this->http->newClient()->post('http://127.0.0.1:8687/workspace/control', [
            'auth' => ['workspace', $password],
            'json' => ['fs' => 'workspace:'] + $data,
            'timeout' => 30,
            'nextcloud' => ['allow_local_address' => true],
        ]);
        return json_decode((string)$response->getBody(), true, 512, JSON_THROW_ON_ERROR);
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

    public function status(array $ids = []): JSONResponse {
        if (count($ids) > 100) { return new JSONResponse(['error' => 'Too many files'], 400); }
        $result = [];
        foreach (array_unique($ids) as $id) {
            try { $result[(string)$id] = $this->remote(['op' => 'status', 'path' => $this->workspacePath((string)$id)]); }
            catch (\Throwable $e) { $result[(string)$id] = ['error' => 'Storage status unavailable']; }
        }
        return new JSONResponse($result);
    }

    public function action(string $id, string $action): JSONResponse {
        if (!in_array($action, ['warm', 'pin', 'cold', 'auto', 'inherit', 'cancel'], true)) {
            return new JSONResponse(['error' => 'Unknown action'], 400);
        }
        try {
            $path = $this->workspacePath($id);
            return new JSONResponse($this->remote(['op' => $action, 'path' => $path]));
        }
        catch (\Throwable $e) { return new JSONResponse(['error' => 'Storage action failed; check the service and file access'], 503); }
    }

    private function requireWorkspace(): void {
        $user = $this->session->getUser();
        if ($user === null) { throw new \RuntimeException('Login required'); }
        $mount = $this->root->getUserFolder($user->getUID())->get('workspace');
        $this->workspacePath((string)$mount->getId());
    }

    public function activity(): JSONResponse {
        try {
            $this->requireWorkspace();
            return new JSONResponse($this->remote(['op' => 'activity']));
        } catch (\Throwable $e) {
            return new JSONResponse(['error' => 'Workspace activity unavailable'], 503);
        }
    }

    public function cancel(?string $path = null): JSONResponse {
        try {
            $this->requireWorkspace();
            // Only paths already in the authenticated backend queue are cancellable.
            return new JSONResponse($this->remote($path === null
                ? ['op' => 'cancel_all'] : ['op' => 'cancel', 'path' => $path]));
        } catch (\Throwable $e) {
            return new JSONResponse(['error' => 'Could not cancel the download'], 503);
        }
    }

    public function settings(?int $budget = null): JSONResponse {
        if ($budget !== null && $budget < 1048576) {
            return new JSONResponse(['error' => 'Budget must be at least 1 MiB'], 400);
        }
        try { return new JSONResponse($this->remote(['op' => 'settings'] + ($budget === null ? [] : ['budget' => $budget]))); }
        catch (\Throwable $e) { return new JSONResponse(['error' => 'Storage settings unavailable'], 503); }
    }
}
