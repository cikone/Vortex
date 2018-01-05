import { setDialogVisible, setOpenMainPage, setOverlayOpen } from '../actions/session';
import { setTabsMinimized } from '../actions/window';
import Banner from '../controls/Banner';
import FlexLayout from '../controls/FlexLayout';
import Icon from '../controls/Icon';
import IconBar from '../controls/IconBar';
import Spinner from '../controls/Spinner';
import { Button, IconButton, NavItem } from '../controls/TooltipControls';
import { IActionDefinition } from '../types/IActionDefinition';
import { IComponentContext } from '../types/IComponentContext';
import { IExtensionApi, IMainPageOptions } from '../types/IExtensionContext';
import { II18NProps } from '../types/II18NProps';
import { IMainPage } from '../types/IMainPage';
import { IProgress, IState } from '../types/IState';
import { connect, extend } from '../util/ComponentEx';
import { getSafe } from '../util/storeHelper';
import Dialog from './Dialog';
import DialogContainer from './DialogContainer';
import DNDContainer from './DNDContainer';
import MainFooter from './MainFooter';
import MainOverlay from './MainOverlay';
import MainPageContainer from './MainPageContainer';
import NotificationButton from './NotificationButton';
import QuickLauncher from './QuickLauncher';
import Settings from './Settings';
import WindowControls from './WindowControls';

import * as I18next from 'i18next';
import * as update from 'immutability-helper';
import * as _ from 'lodash';
import * as PropTypes from 'prop-types';
import * as React from 'react';
import { Badge, Button as ReactButton, ControlLabel, FormGroup,
         Modal, Nav, ProgressBar } from 'react-bootstrap';
// tslint:disable-next-line:no-submodule-imports
import {addStyle} from 'react-bootstrap/lib/utils/bootstrapUtils';
import * as Redux from 'redux';
import { truthy } from '../util/util';

addStyle(ReactButton, 'secondary');
addStyle(ReactButton, 'ad');
addStyle(ReactButton, 'ghost');
addStyle(ReactButton, 'inverted');

interface IPageButtonProps {
  t: I18next.TranslationFunction;
  page: IMainPage;
}

class PageButton extends React.Component<IPageButtonProps, {}> {
  public componentWillMount() {
    const { page } = this.props;
    if (page.badge) {
      page.badge.attach(this);
    }
    if (page.activity) {
      page.activity.attach(this);
    }
  }

  public componentWillUnmount() {
    const { page } = this.props;
    if (page.badge) {
      page.badge.detach(this);
    }
    if (page.activity) {
      page.activity.detach(this);
    }
  }

  public render() {
    const { t, page } = this.props;
    return (
      <div>
        <Icon name={page.icon} />
        <span className='menu-label'>
          {t(page.title)}
        </span>
        {this.renderBadge()}
        {this.renderActivity()}
      </div>
    );
  }

  private renderBadge() {
    const { page } = this.props;

    if (page.badge === undefined) {
      return null;
    }

    return <Badge>{page.badge.calculate()}</Badge>;
  }

  private renderActivity() {
    const { page } = this.props;

    if ((page.activity === undefined) || !page.activity.calculate()) {
      return null;
    }

    return <Spinner />;
  }
}

export interface IBaseProps {
  t: I18next.TranslationFunction;
  className: string;
  api: IExtensionApi;
}

export interface IExtendedProps {
  objects: IMainPage[];
}

export interface IMainWindowState {
  showLayer: string;
  loadedPages: string[];
  hidpi: boolean;
}

export interface IConnectedProps {
  tabsMinimized: boolean;
  overlayOpen: boolean;
  visibleDialog: string;
  mainPage: string;
  secondaryPage: string;
  activeProfileId: string;
  nextProfileId: string;
  progressProfile: { [progressId: string]: IProgress };
  customTitlebar: boolean;
}

export interface IActionProps {
  onSetTabsMinimized: (minimized: boolean) => void;
  onSetOverlayOpen: (open: boolean) => void;
  onSetOpenMainPage: (page: string, secondary: boolean) => void;
  onHideDialog: () => void;
}

export type IProps = IBaseProps & IConnectedProps & IExtendedProps & IActionProps & II18NProps;

export class MainWindow extends React.Component<IProps, IMainWindowState> {
  // tslint:disable-next-line:no-unused-variable
  public static childContextTypes: React.ValidationMap<any> = {
    api: PropTypes.object.isRequired,
    menuLayer: PropTypes.object,
  };

  private applicationButtons: IActionDefinition[];

  private settingsPage: IMainPage;
  private nextState: IMainWindowState;
  private globalButtons: IActionDefinition[] = [];

  private menuLayer: JSX.Element = null;

  private overlayRef: HTMLElement = null;
  private headerRef: HTMLElement = null;
  private sidebarRef: HTMLElement = null;
  private sidebarTimer: NodeJS.Timer;

  constructor(props: IProps) {
    super(props);

    this.state = this.nextState = {
      showLayer: '',
      loadedPages: [],
      hidpi: false,
    };

    this.settingsPage = {
      title: 'Settings',
      group: 'global',
      component: Settings,
      icon: 'settings',
      propsFunc: () => undefined,
      visible: () => true,
    };

    this.applicationButtons = [];

    this.props.api.events.on('show-main-page', title => {
      this.setMainPage(title, false);
    });

    this.props.api.events.on('show-modal', id => {
      this.updateState({
        showLayer: { $set: id },
      });
    });
  }

  public getChildContext(): IComponentContext {
    const { api } = this.props;
    return { api, menuLayer: this.menuLayer };
  }

  public componentWillMount() {
    if (this.props.objects.length > 0) {
      const def = this.props.objects.sort((lhs, rhs) => lhs.priority - rhs.priority)[0];
      this.setMainPage(def.title, false);
    }

    this.updateSize();
  }

  public componentDidMount() {
    window.addEventListener('resize', this.updateSize);
  }

  public componentWillUnmount() {
    window.removeEventListener('resize', this.updateSize);
  }

  public shouldComponentUpdate(nextProps: IProps, nextState: IMainWindowState) {
    return this.props.visibleDialog !== nextProps.visibleDialog
      || this.props.overlayOpen !== nextProps.overlayOpen
      || this.props.tabsMinimized !== nextProps.tabsMinimized
      || this.props.mainPage !== nextProps.mainPage
      || this.props.secondaryPage !== nextProps.secondaryPage
      || this.props.activeProfileId !== nextProps.activeProfileId
      || this.props.nextProfileId !== nextProps.nextProfileId
      || this.props.progressProfile !== nextProps.progressProfile
      || this.state.showLayer !== nextState.showLayer
      || this.state.hidpi !== nextState.hidpi
      ;
  }

  public componentWillReceiveProps(newProps: IProps) {
    const page = newProps.objects.find(iter => iter.title === newProps.mainPage);
    if ((page !== undefined) && !page.visible()) {
      this.setMainPage('Dashboard', false);
    }
  }

  public render(): JSX.Element {
    const { activeProfileId, customTitlebar, onHideDialog,
            nextProfileId, visibleDialog } = this.props;
    const { hidpi } = this.state;

    if ((activeProfileId !== nextProfileId) && truthy(nextProfileId)) {
      return this.renderWait();
    }

    const classes = [];
    classes.push(hidpi ? 'hidpi' : 'lodpi');
    if (customTitlebar) {
      // a border around the window if the standard os frame is disabled.
      // this is important to indicate to the user he can resize the window
      // (even though it's not actually this frame that lets him do it)
      classes.push('window-frame');
    }
    return (
      <div className={classes.join(' ')}>
        <div className='menu-layer' ref={this.setMenuLayer} />
        <FlexLayout id='main-window-content' type='column'>
          {this.renderToolbar()}
          {this.renderBody()}
        </FlexLayout>
        <Dialog />
        <DialogContainer visibleDialog={visibleDialog} onHideDialog={onHideDialog} />
        {customTitlebar ? <WindowControls /> : null}
      </div>
    );
  }

  private renderWait() {
    const { onHideDialog, progressProfile, visibleDialog } = this.props;
    const progress = getSafe(progressProfile, ['deploying'], undefined);
    const control = progress !== undefined
      ? <ProgressBar label={progress.text} now={progress.percent} style={{ width: '50%' }} />
      : <Spinner style={{ width: 64, height: 64 }} />;
    return (
      <div>
        <div className='center-content'>{control}</div>
        <Dialog />
        <DialogContainer visibleDialog={visibleDialog} onHideDialog={onHideDialog} />
      </div>
    );
  }

  private updateState(spec: any) {
    this.nextState = update(this.nextState, spec);
    this.setState(this.nextState);
  }

  private renderToolbar() {
    const { t, customTitlebar } = this.props;
    const className = customTitlebar ? 'toolbar-app-region' : 'toolbar-default';
    return (
      <FlexLayout.Fixed id='main-toolbar' className={className}>
        <QuickLauncher t={t} />
        <Banner group='main-toolbar' />
        <div className='flex-fill' />
        <div className='main-toolbar-right'>
          <NotificationButton id='notification-button' />
          <IconBar
            className='application-icons'
            group='application-icons'
            staticElements={this.applicationButtons}
          />
          <IconBar
            id='global-icons'
            className='global-icons'
            group='global-icons'
            staticElements={this.globalButtons}
            orientation='vertical'
            collapse
          />
        </div>
      </FlexLayout.Fixed>
    );
  }

  private updateSize = () => {
    this.updateState({
      hidpi: { $set: screen.width > 1920 },
    });
  }

  private renderBody() {
    const { t, objects, overlayOpen, tabsMinimized } = this.props;

    const sbClass = tabsMinimized ? 'sidebar-compact' : 'sidebar-expanded';

    const pages = objects.map(obj => this.renderPage(obj));
    pages.push(this.renderPage(this.settingsPage));

    const pageGroups = [
      { title: undefined, key: 'dashboard' },
      { title: 'General', key: 'global' },
      { title: 'Mods', key: 'per-game' },
      { title: 'About', key: 'support' },
    ];

    return (
      <FlexLayout.Flex>
        <FlexLayout type='row' style={{ overflow: 'hidden' }}>
          <FlexLayout.Fixed id='main-nav-sidebar' className={sbClass}>
            <div id='main-nav-container' ref={this.setSidebarRef}>
              {pageGroups.map(this.renderPageGroup)}
            </div>
            <MainFooter slim={tabsMinimized} />
            <Button
              tooltip={tabsMinimized ? t('Restore') : t('Minimize')}
              id='btn-minimize-menu'
              onClick={this.toggleMenu}
              className='btn-menu-minimize'
            >
              <Icon name={tabsMinimized ? 'pane-right' : 'pane-left'} />
            </Button>
          </FlexLayout.Fixed>
          <FlexLayout.Flex fill id='main-window-pane'>
            <DNDContainer style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {pages}
            </DNDContainer>
            <MainOverlay
              open={overlayOpen}
              overlayRef={this.setOverlayRef}
            />
          </FlexLayout.Flex>
        </FlexLayout>
      </FlexLayout.Flex>
    );
  }

  private renderPageGroup = ({ title, key }: { title: string, key: string }): JSX.Element => {
    const { mainPage, objects, tabsMinimized } = this.props;
    const pages = objects.filter(page => (page.group === key) && page.visible());
    if (key === 'global') {
      pages.push(this.settingsPage);
    }

    if (pages.length === 0) {
      return null;
    }

    const showTitle = !tabsMinimized && (title !== undefined);

    return (
      <div key={key}>
        {showTitle ? <p className='main-nav-group-title'>{title}</p> : null}
        <Nav
          bsStyle='pills'
          stacked
          activeKey={mainPage}
          className='main-nav-group'
        >
          {pages.map(this.renderPageButton)}
        </Nav>
      </div>
    );
  }

  private setOverlayRef = ref => {
    this.overlayRef = ref;
  }

  private getOverlayRef = () => this.overlayRef;

  private setHeaderRef = ref => {
    this.headerRef = ref;
  }

  private getHeaderRef = () => this.headerRef;

  private setSidebarRef = ref => {
    this.sidebarRef = ref;
    if (this.sidebarRef !== null) {
      this.sidebarRef.setAttribute('style',
        'min-width: ' + ref.getBoundingClientRect().width + 'px');
    }
  }

  private renderPageButton = (page: IMainPage) => {
    const { t, secondaryPage } = this.props;
    return (
      <NavItem
        id={page.title}
        className={secondaryPage === page.title ? 'secondary' : undefined}
        key={page.title}
        eventKey={page.title}
        tooltip={t(page.title)}
        placement='right'
        onClick={this.handleClickPage}
      >
        <PageButton
          t={this.props.t}
          page={page}
        />
      </NavItem>
    );
  }

  private renderPage(page: IMainPage) {
    const { t, mainPage, secondaryPage } = this.props;
    const { loadedPages } = this.state;

    if (loadedPages.indexOf(page.title) === -1) {
      // don't render pages that have never been opened
      return null;
    }

    const active = [mainPage, secondaryPage].indexOf(page.title) !== -1;

    return (
      <MainPageContainer
        key={page.title}
        page={page}
        active={active}
        secondary={secondaryPage === page.title}
        overlayPortal={this.getOverlayRef}
      />
    );
  }

  private setMenuLayer = (ref) => {
    this.menuLayer = ref;
  }

  private toggleOverlay = () => {
    this.props.onSetOverlayOpen(!this.props.overlayOpen);
  }

  private handleClickPage = (evt: React.MouseEvent<any>) => {
    this.setMainPage(evt.currentTarget.id, evt.ctrlKey);
  }

  private hideLayer = () => this.showLayerImpl('');

  private showLayerImpl(layer: string): void {
    if (this.state.showLayer !== '') {
      this.props.api.events.emit('hide-modal', this.state.showLayer);
    }
    this.updateState({ showLayer: { $set: layer } });
  }

  private setMainPage = (title: string, secondary: boolean) => {
    if (this.props.mainPage !== title) {
      this.props.onSetOverlayOpen(false);
    }
    // set the page as "loaded", set it as the shown page next frame.
    // this way it gets rendered as hidden once and can then "transition"
    // to visible
    this.updateState({
      loadedPages: { $push: [title] },
    });
    setImmediate(() => {
      if (secondary && (title === this.props.secondaryPage)) {
        this.props.onSetOpenMainPage('', secondary);
      } else {
        this.props.onSetOpenMainPage(title, secondary);
      }
    });
  }

  private toggleMenu = () => {
    const newMinimized = !this.props.tabsMinimized;
    this.props.onSetTabsMinimized(newMinimized);
    if (this.sidebarTimer !== undefined) {
      clearTimeout(this.sidebarTimer);
      this.sidebarTimer = undefined;
    }
    if (this.sidebarRef !== null) {
      if (newMinimized) {
        this.sidebarRef.setAttribute('style', '');
      } else {
        this.sidebarTimer = setTimeout(() => {
          this.sidebarTimer = undefined;
          this.sidebarRef.setAttribute('style',
            'min-width:' + this.sidebarRef.getBoundingClientRect().width + 'px');
        }, 500);
      }
    }
  }
}

function trueFunc() {
  return true;
}

function emptyFunc() {
  return {};
}

function mapStateToProps(state: IState): IConnectedProps {
  return {
    tabsMinimized: getSafe(state, ['settings', 'window', 'tabsMinimized'], false),
    overlayOpen: state.session.base.overlayOpen,
    visibleDialog: state.session.base.visibleDialog,
    mainPage: state.session.base.mainPage,
    secondaryPage: state.session.base.secondaryPage,
    activeProfileId: state.settings.profiles.activeProfileId,
    nextProfileId: state.settings.profiles.nextProfileId,
    progressProfile: getSafe(state.session.base, ['progress', 'profile'], undefined),
    customTitlebar: state.settings.window.customTitlebar,
  };
}

function mapDispatchToProps(dispatch: Redux.Dispatch<any>): IActionProps {
  return {
    onSetTabsMinimized: (minimized: boolean) => dispatch(setTabsMinimized(minimized)),
    onSetOverlayOpen: (open: boolean) => dispatch(setOverlayOpen(open)),
    onSetOpenMainPage:
      (page: string, secondary: boolean) => dispatch(setOpenMainPage(page, secondary)),
    onHideDialog: () => dispatch(setDialogVisible(undefined)),
  };
}

function registerMainPage(
  instanceProps: IBaseProps,
  icon: string,
  title: string,
  component: React.ComponentClass<any> | React.StatelessComponent<any>,
  options: IMainPageOptions) {
  return {
    icon, title, component,
    propsFunc: options.props || emptyFunc,
    visible: options.visible || trueFunc,
    group: options.group,
    badge: options.badge,
    activity: options.activity,
    priority: options.priority !== undefined ? options.priority : 100,
  };
}

export default
  extend(registerMainPage)(
    connect(mapStateToProps, mapDispatchToProps)(MainWindow),
  ) as React.ComponentClass<IBaseProps>;
