/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import * as React from 'react';
import { Provider } from 'react-redux';
import { stripIndent } from 'common-tags';
// This module is mocked.
import copy from 'copy-to-clipboard';

import { render, screen } from 'firefox-profiler/test/fixtures/testing-library';
import { MarkerTable } from '../../components/marker-table';
import { MaybeMarkerContextMenu } from '../../components/shared/MarkerContextMenu';
import {
  updatePreviewSelection,
  changeMarkersSearchString,
  hideGlobalTrack,
  hideLocalTrack,
  selectTrack,
} from '../../actions/profile-view';
import { ensureExists } from '../../utils/flow';
import { getEmptyThread } from 'firefox-profiler/profile-logic/data-structures';

import { storeWithProfile } from '../fixtures/stores';
import {
  getProfileFromTextSamples,
  getMarkerTableProfile,
  addMarkersToThreadWithCorrespondingSamples,
  addIPCMarkerPairToThreads,
} from '../fixtures/profiles/processed-profile';
import { fireFullClick, fireFullContextMenu } from '../fixtures/utils';
import { autoMockElementSize } from '../fixtures/mocks/element-size';
import {
  getProfileWithNiceTracks,
  getHumanReadableTracks,
} from '../fixtures/profiles/tracks';
import * as UrlStateSelectors from '../../selectors/url-state';

import type { CauseBacktrace } from 'firefox-profiler/types';

describe('MarkerTable', function () {
  // Set an arbitrary size that will not kick in any virtualization behavior.
  autoMockElementSize({ width: 2000, height: 1000 });

  function setup(profile = getMarkerTableProfile()) {
    const store = storeWithProfile(profile);
    const renderResult = render(
      <Provider store={store}>
        <>
          <MaybeMarkerContextMenu />
          <MarkerTable />
        </>
      </Provider>
    );
    const { container } = renderResult;

    const fixedRows = () =>
      Array.from(container.querySelectorAll('.treeViewRowFixedColumns'));
    const scrolledRows = () =>
      Array.from(container.querySelectorAll('.treeViewRowScrolledColumns'));

    const getRowElement = (functionName) =>
      ensureExists(
        screen.getByText(functionName).closest('.treeViewRow'),
        `Couldn't find the row for node ${String(functionName)}.`
      );
    const getContextMenu = () =>
      ensureExists(
        container.querySelector('.react-contextmenu'),
        `Couldn't find the context menu.`
      );

    return {
      ...renderResult,
      ...store,
      fixedRows,
      scrolledRows,
      getRowElement,
      getContextMenu,
    };
  }

  it('renders some basic markers and updates when needed', () => {
    const { container, fixedRows, scrolledRows, dispatch } = setup();

    expect(fixedRows()).toHaveLength(7);
    expect(scrolledRows()).toHaveLength(7);
    expect(container.firstChild).toMatchSnapshot();

    /* Check that the table updates properly despite the memoisation. */
    dispatch(
      updatePreviewSelection({
        hasSelection: true,
        isModifying: false,
        selectionStart: 10,
        selectionEnd: 20,
      })
    );

    expect(fixedRows()).toHaveLength(2);
    expect(scrolledRows()).toHaveLength(2);
  });

  it('selects a row when left clicking', () => {
    const { getByText, getRowElement } = setup();

    fireFullClick(getByText(/setTimeout/));
    expect(getRowElement(/setTimeout/)).toHaveClass('isSelected');

    fireFullClick(getByText('foobar'));
    expect(getRowElement(/setTimeout/)).not.toHaveClass('isSelected');
    expect(getRowElement('foobar')).toHaveClass('isSelected');
  });

  it('displays a context menu when right clicking', () => {
    jest.useFakeTimers();

    const { getContextMenu, getRowElement, getByText } = setup();

    function checkMenuIsDisplayedForNode(str) {
      expect(getContextMenu()).toHaveClass('react-contextmenu--visible');

      // Note that selecting a menu item will close the menu.
      fireFullClick(getByText('Copy description'));
      expect(copy).toHaveBeenLastCalledWith(expect.stringMatching(str));
    }

    fireFullContextMenu(getByText(/setTimeout/));
    checkMenuIsDisplayedForNode(/setTimeout/);
    expect(getRowElement(/setTimeout/)).toHaveClass('isRightClicked');

    // Wait that all timers are done before trying again.
    jest.runAllTimers();

    // Now try it again by right clicking 2 nodes in sequence.
    fireFullContextMenu(getByText(/setTimeout/));
    fireFullContextMenu(getByText('foobar'));
    checkMenuIsDisplayedForNode('foobar');
    expect(getRowElement(/setTimeout/)).not.toHaveClass('isRightClicked');
    expect(getRowElement('foobar')).toHaveClass('isRightClicked');

    // Wait that all timers are done before trying again.
    jest.runAllTimers();

    // And now let's do it again, but this time waiting for timers before
    // clicking, because the timer can impact the menu being displayed.
    fireFullContextMenu(getByText('NotifyDidPaint'));
    fireFullContextMenu(getByText('foobar'));
    jest.runAllTimers();
    checkMenuIsDisplayedForNode('foobar');
    expect(getRowElement('foobar')).toHaveClass('isRightClicked');
  });

  it("can copy a marker's cause using the context menu", () => {
    jest.useFakeTimers();

    // This is a tid we'll reuse later.
    const tid = 4444;

    // Just a simple profile with 1 thread and a nice stack.
    const {
      profile,
      funcNamesDictPerThread: [{ E }],
    } = getProfileFromTextSamples(`
      A[lib:libxul.so]
      B[lib:libxul.so]
      C[lib:libxul.so]
      D[lib:libxul.so]
      E[lib:libxul.so]
    `);
    profile.threads[0].name = 'Main Thread';

    // Add another thread with a known tid that we'll reuse in the marker's cause.
    profile.threads.push(getEmptyThread({ name: 'Another Thread', tid }));
    // Add the reflow marker to the first thread.
    addMarkersToThreadWithCorrespondingSamples(profile.threads[0], [
      getReflowMarker(3, 100, {
        tid: tid,
        // We're cheating a bit here: E is a funcIndex, but because of how
        // getProfileFromTextSamples works internally, this will be the right
        // stackIndex too.
        stack: E,
        time: 1,
      }),
    ]);

    const { getByText } = setup(profile);
    fireFullContextMenu(getByText(/Reflow/));
    fireFullClick(getByText('Copy call stack'));
    expect(copy).toHaveBeenLastCalledWith(stripIndent`
      A [libxul.so]
      B [libxul.so]
      C [libxul.so]
      D [libxul.so]
      E [libxul.so]
    `);
  });

  describe('EmptyReasons', () => {
    it('shows reasons when a profile has no non-network markers', () => {
      const { profile } = getProfileFromTextSamples('A'); // Just a simple profile without any marker.
      const { container } = setup(profile);
      expect(container.querySelector('.EmptyReasons')).toMatchSnapshot();
    });

    it('shows reasons when all non-network markers have been filtered out', function () {
      const { dispatch, container } = setup();
      dispatch(changeMarkersSearchString('MATCH_NOTHING'));
      expect(container.querySelector('.EmptyReasons')).toMatchSnapshot();
    });
  });

  describe('IPC marker context menu item', () => {
    /**
     * Using the following tracks:
     *  [
     *    'show [thread GeckoMain process]',
     *    'show [thread GeckoMain tab]',
     *    '  - show [thread DOM Worker]',
     *    '  - show [thread Style]',
     *  ]
     */
    const parentTrackReference = { type: 'global', trackIndex: 0 };
    const tabTrackReference = { type: 'global', trackIndex: 1 };
    const domWorkerTrackReference = { type: 'local', trackIndex: 0, pid: 222 };
    const styleTrackReference = { type: 'local', trackIndex: 1, pid: 222 };
    const parentThreadIndex = 0;
    const domWorkerThreadIndex = 2;
    const styleThreadIndex = 3;
    const tabPid = 222;
    function setupWithTracksAndIPCMarker() {
      const profile = getProfileWithNiceTracks();
      addIPCMarkerPairToThreads(
        {
          startTime: 1,
          endTime: 10,
          messageSeqno: 1,
        },
        profile.threads[0], // Parent process
        profile.threads[1] // tab process
      );

      addIPCMarkerPairToThreads(
        {
          startTime: 11,
          endTime: 20,
          messageSeqno: 2,
        },
        profile.threads[0], // Parent process
        profile.threads[2] // DOM Worker
      );

      // Add an incomplete IPC marker to the Style thread.
      // We do not add the other marker pair to another thread on purpose.
      addMarkersToThreadWithCorrespondingSamples(profile.threads[3], [
        [
          'IPC',
          20,
          25,
          {
            type: 'IPC',
            startTime: 20,
            endTime: 25,
            otherPid: 444,
            messageSeqno: 3,
            messageType: 'PContent::Msg_PreferenceUpdate',
            side: 'parent',
            direction: 'sending',
            phase: 'endpoint',
            sync: false,
            niceDirection: `sending to 444`,
          },
        ],
      ]);

      return setup(profile);
    }

    it('can switch to another global track', function () {
      const { getState } = setupWithTracksAndIPCMarker();
      fireFullContextMenu(screen.getByText(/IPCIn/));
      fireFullClick(screen.getByText(/Select the sender/));
      expect(UrlStateSelectors.getSelectedThreadIndexes(getState())).toEqual(
        new Set([parentThreadIndex])
      );
    });

    it('can switch to a hidden global track', function () {
      const { getState, dispatch } = setupWithTracksAndIPCMarker();
      // Hide the global track first.
      dispatch(hideGlobalTrack(parentTrackReference.trackIndex));
      // Make sure that it's hidden.
      expect(getHumanReadableTracks(getState())).toEqual([
        'hide [thread GeckoMain process]',
        '  - show [ipc GeckoMain]',
        'show [thread GeckoMain tab] SELECTED',
        '  - show [thread DOM Worker]',
        '  - show [thread Style]',
        '  - show [ipc GeckoMain] SELECTED',
        '  - show [ipc DOM Worker]',
        '  - show [ipc Style]',
      ]);

      // Check the actual behavior now.
      fireFullContextMenu(screen.getByText(/IPCIn/));
      fireFullClick(screen.getByText(/Select the sender/));
      expect(UrlStateSelectors.getSelectedThreadIndexes(getState())).toEqual(
        new Set([parentThreadIndex])
      );
      // Make sure that it's not hidden anymore.
      expect(getHumanReadableTracks(getState())).toEqual([
        'show [thread GeckoMain process] SELECTED',
        '  - show [ipc GeckoMain] SELECTED',
        'show [thread GeckoMain tab]',
        '  - show [thread DOM Worker]',
        '  - show [thread Style]',
        '  - show [ipc GeckoMain]',
        '  - show [ipc DOM Worker]',
        '  - show [ipc Style]',
      ]);
    });

    it('can switch to a local track', function () {
      const { getState, dispatch } = setupWithTracksAndIPCMarker();
      dispatch(selectTrack(parentTrackReference, 'none'));
      // Make sure that we are in the parent process thread.
      expect(UrlStateSelectors.getSelectedThreadIndexes(getState())).toEqual(
        new Set([parentThreadIndex])
      );

      // Check if we can switch to the DOM Worker properly.
      fireFullContextMenu(screen.getByText(/sent to DOM Worker/));
      fireFullClick(screen.getByText(/Select the receiver/));

      expect(UrlStateSelectors.getSelectedThreadIndexes(getState())).toEqual(
        new Set([domWorkerThreadIndex])
      );
    });

    it('can switch to a hidden local track', function () {
      const { getState, dispatch } = setupWithTracksAndIPCMarker();
      dispatch(selectTrack(parentTrackReference, 'none'));
      // Make sure that we are in the parent process thread.
      expect(UrlStateSelectors.getSelectedThreadIndexes(getState())).toEqual(
        new Set([parentThreadIndex])
      );
      // Hide the global and local tracks.
      dispatch(hideLocalTrack(tabPid, domWorkerTrackReference.trackIndex));
      dispatch(hideGlobalTrack(tabTrackReference.trackIndex));
      // Make sure that they are hidden.
      expect(getHumanReadableTracks(getState())).toEqual([
        'show [thread GeckoMain process] SELECTED',
        '  - show [ipc GeckoMain] SELECTED',
        'hide [thread GeckoMain tab]',
        '  - hide [thread DOM Worker]',
        '  - show [thread Style]',
        '  - show [ipc GeckoMain]',
        '  - show [ipc DOM Worker]',
        '  - show [ipc Style]',
      ]);

      // Check the actual behavior now.
      fireFullContextMenu(screen.getByText(/sent to DOM Worker/));
      fireFullClick(screen.getByText(/Select the receiver/));
      expect(UrlStateSelectors.getSelectedThreadIndexes(getState())).toEqual(
        new Set([domWorkerThreadIndex])
      );
      // Make sure that they are not hidden anymore.
      expect(getHumanReadableTracks(getState())).toEqual([
        'show [thread GeckoMain process]',
        '  - show [ipc GeckoMain]',
        'show [thread GeckoMain tab]',
        '  - show [thread DOM Worker] SELECTED',
        '  - show [thread Style]',
        '  - show [ipc GeckoMain]',
        '  - show [ipc DOM Worker] SELECTED',
        '  - show [ipc Style]',
      ]);
    });

    it('does not render when the other thread is not profiled', function () {
      const { getState, dispatch } = setupWithTracksAndIPCMarker();
      dispatch(selectTrack(styleTrackReference, 'none'));
      // Make sure that we are in the Style thread.
      expect(UrlStateSelectors.getSelectedThreadIndexes(getState())).toEqual(
        new Set([styleThreadIndex])
      );

      // Silence console logs coming from the component.
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      // Make sure that it's not in the context menu.
      fireFullContextMenu(screen.getByText(/IPCOut/));
      expect(screen.queryByText(/Select the/)).not.toBeInTheDocument();
    });
  });
});

function getReflowMarker(
  startTime: number,
  endTime: number,
  cause?: CauseBacktrace
) {
  return [
    'Reflow',
    startTime,
    endTime,
    {
      type: 'tracing',
      category: 'Paint',
      cause,
    },
  ];
}
