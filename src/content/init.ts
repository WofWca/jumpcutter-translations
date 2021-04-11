import browser from '@/webextensions-api';
import { addOnSettingsChangedListener, removeOnSettingsChangedListener, MyStorageChanges } from '@/settings';
import type AllMediaElementsController from './AllMediaElementsController';
import broadcastStatus from './broadcastStatus';

const broadcastStatus2 = (allMediaElementsController?: AllMediaElementsController) => allMediaElementsController
  ? allMediaElementsController.broadcastStatus()
  : broadcastStatus({ elementLastActivatedAt: undefined });

// TODO if it get standardized, we can simplify this.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nativeRequestIdleCallback = (window as any).requestIdleCallback;
const myRequestIdleCallback = nativeRequestIdleCallback
  ? (cb: () => void) => nativeRequestIdleCallback(cb, { timeout: 5000 })
  : (cb: () => void) => setTimeout(() => setTimeout(cb));

export default function init(): void {
  let allMediaElementsController: AllMediaElementsController | undefined;
  async function ensureInitAllMediaElementsController() {
    if (allMediaElementsController) return;
    const { default: AllMediaElementsController } = await import(
      /* webpackExports: ['default'] */
      './AllMediaElementsController'
    )
    allMediaElementsController = new AllMediaElementsController();
    return allMediaElementsController;
  }

  // The user might have enabled access to file URL for this extension. This is so it behaves the same way when access
  // is disabled. And why do we need that? Because it doesn't work with local files:
  // https://github.com/WofWca/jumpcutter/issues/5
  if (location.protocol === 'file:') {
    return;
  }

  const onMessage = (message: unknown) => {
    if (process.env.NODE_ENV !== 'production') {
      if (message !== 'checkContentStatus') { // TODO DRY.
        console.error('Unrecognized message', message);
      }
    }
    broadcastStatus2(allMediaElementsController);
  }
  browser.runtime.onMessage.addListener(onMessage);
  // So it sends the message automatically when it loads, in case the popup was opened while the page is loading.
  broadcastStatus2(allMediaElementsController);
  const onSettingsChanged = (changes: MyStorageChanges) => {
    if (changes.enabled?.newValue === false) {
      browser.runtime.onMessage.removeListener(onMessage);
      mutationObserver.disconnect();
      removeOnSettingsChangedListener(onSettingsChanged);
    }
  }
  addOnSettingsChangedListener(onSettingsChanged);

  const targetTagName = 'video';
  const allMediaElements = document.getElementsByTagName(targetTagName);
  if (allMediaElements.length) {
    ensureInitAllMediaElementsController().then(() => {
      allMediaElementsController!.onNewMediaElements(...allMediaElements);
    });
  }
  // Peeked at https://github.com/igrigorik/videospeed/blob/a25373f1d831fe06430c2e9e87dc1bd1aabd25b1/inject.js#L631
  function handleMutations(mutations: MutationRecord[]) {
    const newElements: HTMLMediaElement[] = [];
    for (const m of mutations) {
      if (m.type !== 'childList') {
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        // The fact that we have an array of `addedNodes` in an array of mutations may mean (idk actually) that
        // we can have tuplicate nodes in the array, which currently is fine (see `onNewMediaElements`).
        if (node.nodeName === targetTagName) {
          newElements.push(node as HTMLMediaElement);
        } else {
          // TODO here https://developer.mozilla.org/en-US/docs/Web/API/Element/getElementsByTagName
          // it says "The returned list is live, which means it updates itself with the DOM tree automatically".
          // Does it mean that it would be better to somehow use the `allMediaElements` variable from a few lines above?
          // But here https://dom.spec.whatwg.org/#introduction-to-dom-ranges it says that upgdating live ranges can be
          // costly.
          const childMediaElements = (node as HTMLElement).getElementsByTagName(targetTagName);
          if (childMediaElements.length) {
            newElements.push(...childMediaElements);
          }
        }
      }
      // TODO should we also manually detach from removed nodes? If so, this is probably to be done in
      // `AllMediaElementsController.ts`. But currently it is made so that there's at most one Controller
      // (attached to just one element), so it's fine.
    }
    if (newElements.length) {
      ensureInitAllMediaElementsController().then(() => {
        allMediaElementsController!.onNewMediaElements(...newElements);
      });
    }
  }
  const handleMutationsOnIdle =
    (mutations: MutationRecord[]) => myRequestIdleCallback(() => handleMutations(mutations));
  const mutationObserver = new MutationObserver(handleMutationsOnIdle);
  mutationObserver.observe(document, {
    subtree: true,
    childList: true, // Again, why `subtree: true` is not enough here?
  });
}