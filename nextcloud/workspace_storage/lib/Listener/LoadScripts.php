<?php
declare(strict_types=1);
namespace OCA\WorkspaceStorage\Listener;

use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IGroupManager;
use OCP\IUserSession;
use OCP\Util;

class LoadScripts implements IEventListener {
    public function __construct(private IUserSession $session, private IGroupManager $groups) {}
    public function handle(Event $event): void {
        $user = $this->session->getUser();
        if ($user !== null && $this->groups->isAdmin($user->getUID())) {
            Util::addScript('workspace_storage', 'workspace');
            Util::addStyle('workspace_storage', 'workspace');
        }
    }
}
