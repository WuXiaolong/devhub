/* global __DEV__ */

import * as firebase from 'firebase';
import { debounce } from 'lodash';

import { FIREBASE_RECEIVED_EVENT } from '../../../utils/constants/actions';
import { firebaseReceivedEvent } from '../../../actions';
import { mapFirebaseToState, mapStateToFirebase } from '../../../reducers/firebase';
import { toJS } from '../../../utils/immutable';
import { getObjectDiff, getObjectFilteredByMap, fixFirebaseKeysFromObject, getMapSubtractedByMap } from './helpers';
import { applyPatchOnFirebase, watchFirebaseFromMap } from './lib';
import { isLoggedSelector, isReadySelector } from '../../../selectors';

let _currentUserId;
let _databaseRef;
let _lastState;

const checkDiffAndPatchDebounced = debounce(
  (stateA, stateB, map, store) => {
    if (_databaseRef && stateA !== undefined) {
      const fixedStateA = fixFirebaseKeysFromObject(stateA, true);
      const fixedStateB = fixFirebaseKeysFromObject(stateB, true);

      const stateDiff = toJS(getObjectDiff(fixedStateA, fixedStateB, map));
      // console.log('state diff', stateDiff);
      // console.log('states before diff', toJS(fixedStateA), toJS(fixedStateA));

      if (stateDiff && _currentUserId) {
        applyPatchOnFirebase({ debug: __DEV__, patch: stateDiff });
        _lastState = store.getState();
      }
    }
  },
  300,
);

export function stopFirebase() {
  if (!_databaseRef) return;

  console.debug('[FIREBASE] Disconnected.');
  _databaseRef.off();

  _databaseRef = undefined;
  _lastState = undefined;
}

export function startFirebase({ store, userId }) {
  stopFirebase();

  _databaseRef = firebase.database().ref(`users/${userId}/`);
  console.debug('[FIREBASE] Connected.');

  // get all the data on firebase and compare with the local state.
  // upload to firebase the fields that are different, but not all of them,
  // just the ones that we will naver get from firebase again
  // (which means the difference from mapStateToFirebase and mapFirebaseToState)
  // e.g. these fields will be uploaded: app/version, user/loggedAt, ...
  // because we'll never get theses fields from firebase, we just upload them.
  // they are more 'local' fields that doesnt make sense to sync.
  _databaseRef.once('value', (snapshot) => {
    const value = snapshot.val();

    const missingOnFirebaseMap = getMapSubtractedByMap(mapStateToFirebase, mapFirebaseToState);
    const firebaseData = getObjectFilteredByMap(value, missingOnFirebaseMap);
    const localData = getObjectFilteredByMap(store.getState(), missingOnFirebaseMap);

    checkDiffAndPatchDebounced(firebaseData, localData, missingOnFirebaseMap, store);
  });

  watchFirebaseFromMap({
    callback({ eventName, firebasePathArr, statePathArr, value }) {
      store.dispatch(firebaseReceivedEvent({ eventName, firebasePathArr, statePathArr, value }));
      _lastState = store.getState();
    },
    debug: __DEV__,
    map: mapFirebaseToState,
    ref: _databaseRef,
  });
}

export default store => next => (action = {}) => {
  next(action);

  const isAppReady = isReadySelector(store.getState());

  if (!isAppReady || action.type === FIREBASE_RECEIVED_EVENT) {
    return;
  }

  const isLogged = isLoggedSelector(store.getState());
  const userId = isLogged && (firebase.auth().currentUser || {}).uid;

  if (userId !== _currentUserId) {
    _currentUserId = userId;

    if (userId) {
      startFirebase({ store, userId });
    } else {
      stopFirebase();
    }
  }

  checkDiffAndPatchDebounced(_lastState, store.getState(), mapStateToFirebase, store);
};