<?php
declare(strict_types=1);
namespace OCA\WorkspaceStorage\AppInfo;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\WorkspaceStorage\Listener\LoadScripts;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

class Application extends App implements IBootstrap {
    public function __construct() { parent::__construct('workspace_storage'); }
    public function register(IRegistrationContext $context): void {
        $context->registerEventListener(LoadAdditionalScriptsEvent::class, LoadScripts::class);
    }
    public function boot(IBootContext $context): void {}
}
