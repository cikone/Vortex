import {setPluginOrder} from './actions/loadOrder';
import {IPluginsLoot} from './types/IPlugins';
import {gameSupported, lootAppPath, pluginPath} from './util/gameSupport';

import * as Bluebird from 'bluebird';
import { remote } from 'electron';
import {Loot as LootT} from 'loot';
import * as path from 'path';
import * as Redux from 'redux';
import {} from 'redux-thunk';
import {actions, fs, log, selectors, types, util} from 'vortex-api';
import userlist from './reducers/userlist';

function sortAsync(loot: LootT, input: string[]) {
  return new Bluebird<string[]>((resolve, reject) => {
    loot.sortPlugins(input, (err, sorted) => {
      if (err !== null) {
        return reject(err);
      }
      return resolve(sorted);
    });
  });
}

function loadListsAsync(loot: LootT, masterlistPath: string, userlistPath: string) {
  return new Bluebird<void>((resolve, reject) => {
    loot.loadLists(masterlistPath, userlistPath, (err) => {
      if (err !== null) {
        return reject(err);
      }
      return resolve();
    });
  });
}

function updateAsync(loot: LootT, masterlistPath: string,
                     repoUrl: string, repoBranch: string) {
  return new Bluebird<boolean>((resolve, reject) => {
    loot.updateMasterlist(masterlistPath, repoUrl, repoBranch, (err, didUpdate) => {
      if (err !== null) {
        return reject(err);
      }
      return resolve(didUpdate);
    });
  });
}

class LootInterface {
  private mExtensionApi: types.IExtensionApi;
  private mInitPromise: Bluebird<{ game: string, loot: LootT }> =
    Bluebird.resolve({ game: undefined, loot: undefined });
  private mSortPromise: Bluebird<string[]> = Bluebird.resolve([]);

  private mUserlistTime: Date;

  constructor(context: types.IExtensionContext) {
    const store = context.api.store;

    this.mExtensionApi = context.api;

    // when the game changes, we need to re-initialize loot for that game
    context.api.events.on('gamemode-activated',
      gameMode => this.onGameModeChanged(context, gameMode));

    { // in case the initial gamemode-activated event was already sent,
      // initialize right away
      const gameMode = selectors.activeGameId(store.getState());
      if (gameMode) {
        this.onGameModeChanged(context, gameMode);
      }
    }

    // on demand, re-sort the plugin list
    context.api.events.on('autosort-plugins', this.onSort);

    context.api.events.on('plugin-details', this.pluginDetails);
  }

  public async wait(): Promise<void> {
    await this.mInitPromise;
    await this.mSortPromise;
  }

  private onSort = async (manual: boolean) => {
    const { translate, store } = this.mExtensionApi;
    if (manual || store.getState().settings.plugins.autoSort) {
      const t = translate;

      // ensure initialisation is done
      const { game, loot } = await this.mInitPromise;

      const state = store.getState();
      const gameMode = selectors.activeGameId(state);
      if ((gameMode !== game) || !gameSupported(gameMode)) {
        return;
      }

      const id = require('shortid').generate();

      const pluginNames: string[] = Object
        .keys(state.loadOrder)
        .filter((name: string) => (state.session.plugins.pluginList[name] !== undefined));

      // ensure no other sort is in progress
      try {
        await this.mSortPromise;
      // tslint:disable-next-line:no-empty
      } catch (err) {}

      try {
        store.dispatch(actions.startActivity('plugins', 'sorting'));
        this.mSortPromise =
          this.readLists(gameMode, loot)
          .then(() => sortAsync(loot, pluginNames));
        const sorted: string[] = await this.mSortPromise;
        store.dispatch(actions.stopActivity('plugins', 'sorting'));
        store.dispatch(setPluginOrder(sorted));
      } catch (err) {
        log('info', 'loot failed', { error: err.message });
        if (err.message.startsWith('Cyclic interaction')) {
          this.reportCycle(err);
        } else if (err.message.endsWith('is not a valid plugin')) {
          this.mExtensionApi.sendNotification({
            id: 'loot-failed',
            type: 'warning',
            message: this.mExtensionApi.translate('Not sorted because: {{msg}}',
              { replace: { msg: err.message }, ns: 'gamebryo-plugin' }),
          });
        } else {
          this.mExtensionApi.showErrorNotification('LOOT operation failed',
                                                   err, { id: 'loot-failed' });
        }
      }

    }
    return Promise.resolve();
  }

  private onGameModeChanged = async (context: types.IExtensionContext, gameMode: string) => {
    const { game, loot } = await this.mInitPromise;
    if (gameMode === game) {
      // no change
      return;
    }
    const store = context.api.store;
    const gamePath: string = selectors.currentGameDiscovery(store.getState()).path;
    if (gameSupported(gameMode)) {
      try {
        this.mInitPromise = this.init(gameMode, gamePath);
      } catch (err) {
        context.api.showErrorNotification('Failed to initialize LOOT', {
          message: err.message,
          game: gameMode,
          path: gamePath,
        });
        this.mInitPromise = Bluebird.resolve({ game: gameMode, loot: undefined });
      }
    } else {
      this.mInitPromise = Bluebird.resolve({ game: gameMode, loot: undefined });
    }
  }

  private pluginDetails = async (plugins: string[], callback: (result: IPluginsLoot) => void) => {
    const { game, loot } = await this.mInitPromise;
    if (loot === undefined) {
      callback({});
      return;
    }
    const t = this.mExtensionApi.translate;
    const result: IPluginsLoot = {};
    plugins.forEach((pluginName: string) => {
      const meta = loot.getPluginMetadata(pluginName);
      result[pluginName] = {
        messages: meta.messages,
        tags: meta.tags,
        cleanliness: meta.cleanInfo,
        dirtyness: meta.dirtyInfo,
        globalPriority: meta.globalPriority,
      };
    });
    callback(result);
  }

  // tslint:disable-next-line:member-ordering
  private readLists = Bluebird.method(async (gameMode: string, loot: LootT) => {
    const t = this.mExtensionApi.translate;
    const masterlistPath = path.join(lootAppPath(gameMode), 'masterlist.yaml');
    const userlistPath = path.join(remote.app.getPath('userData'), gameMode, 'userlist.yaml');

    let mtime: Date;
    try {
      mtime = (await fs.statAsync(userlistPath)).mtime;
    } catch (err) {
      mtime = null;
    }

    // load & evaluate lists first time we need them and whenever
    // the userlist has changed
    if ((mtime !== null) &&
        ((this.mUserlistTime === undefined) ||
          (this.mUserlistTime.getTime() !== mtime.getTime()))) {
      log('info', '(re-)loading loot lists', {
        mtime,
        masterlistPath,
        userlistPath,
        last: this.mUserlistTime,
      });
      await loadListsAsync(loot, masterlistPath, mtime !== null ? userlistPath : '');
      log('info', 'loaded loot lists');
      this.mUserlistTime = mtime;
    }
  });

  // tslint:disable-next-line:member-ordering
  private init = Bluebird.method(async (gameMode: string, gamePath: string) => {
    const t = this.mExtensionApi.translate;
    const localPath = pluginPath(gameMode);
    await fs.ensureDirAsync(localPath);

    const {Loot} = require('loot');
    const loot: LootT = new Loot(gameMode, gamePath, localPath);

    const masterlistPath = path.join(lootAppPath(gameMode), 'masterlist.yaml');
    try {
      await fs.ensureDirAsync(path.dirname(masterlistPath));
      const updated = await updateAsync(loot, masterlistPath,
        `https://github.com/loot/${gameMode}.git`,
        'v0.10');
      log('info', 'updated loot masterlist', updated);
    } catch (err) {
      this.mExtensionApi.showErrorNotification(
        'failed to update masterlist', err);
    }

    return { game: gameMode, loot };
  });

  private reportCycle(err: Error) {
    this.mExtensionApi.sendNotification({
      type: 'warning',
      message: 'Plugins not sorted because of cyclic rules',
      actions: [
        {
          title: 'More',
          action: (dismiss: () => void) => {
            const bbcode = this.mExtensionApi.translate(
              'LOOT reported a cyclic interaction between rules.<br />'
              + 'In the simplest case this is something like '
              + '[i]"A needs to load after B"[/i] and [i]"B needs to load after A"[/i] '
              + 'but it can be arbitrarily complicated: [i]"A after B after C after A"[/i].<br />'
              + 'This conflict involves at least one custom rule.<br />'
              + 'Please read the LOOT message and change your custom rules to resolve the cycle: '
              + '[quote]' + err.message + '[/quote]', { ns: 'gamebryo-plugin' });
            this.mExtensionApi.store.dispatch(
                actions.showDialog('info', 'Cyclic interaction', {bbcode}, [
                  {
                    label: 'Close',
                  },
                ]));
          },
        },
      ],
    });
  }
}

export default LootInterface;
