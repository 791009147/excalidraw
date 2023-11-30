import { getDefaultAppState } from "./appState";
import { AppStateChange, ElementsChange } from "./change";
import { deepCopyElement } from "./element/newElement";
import { ExcalidrawElement } from "./element/types";
import { Emitter } from "./emitter";
import Scene from "./scene/Scene";
import { AppState } from "./types";
import { isShallowEqual } from "./utils";

const getObservedAppState = (appState: AppState) => {
  return {
    name: appState.name,
    editingGroupId: appState.editingGroupId,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    selectedGroupIds: appState.selectedGroupIds,
    editingLinearElement: appState.editingLinearElement,
    selectedLinearElement: appState.selectedLinearElement, // TODO: Think about these two as one level shallow equal is not enough for them (they have new reference even though they shouldn't, sometimes their id does not correspond to selectedElementId)
  };
};

export interface IStore {
  capture(scene: Scene, appState: AppState): void;
  listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ): ReturnType<Emitter["on"]>;
  clear(): void;
}

/**
 * In the future, Store should coordinate the changes and maintain its increments cohesive between different instances.
 */
export class Store implements IStore {
  // TODO: Add a specific increment type which could be a squash of multiple changes
  private readonly onStoreIncrementEmitter = new Emitter<
    [elementsChange: ElementsChange, appStateChange: AppStateChange]
  >();

  private recordingChanges: boolean = false;
  private shouldOnlyUpdateSnapshot: boolean = false;
  private isRemoteUpdate: boolean = false;

  private snapshot = Snapshot.empty();

  // Suspicious that this is called so many places. Seems error-prone.
  public resumeRecording() {
    this.recordingChanges = true;
  }

  public onlyUpdateSnapshot() {
    this.shouldOnlyUpdateSnapshot = true;
  }

  public markRemoteUpdate() {
    this.isRemoteUpdate = true;
  }

  public listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ) {
    return this.onStoreIncrementEmitter.on(callback);
  }

  public capture(scene: Scene, appState: AppState): void {
    // Quick exit for irrelevant changes
    if (!this.recordingChanges && !this.shouldOnlyUpdateSnapshot) {
      return;
    }

    const nextElements = scene.getElementsMapIncludingDeleted();
    const snapshotOptions: CloningOptions = {
      isRemoteUpdate: this.isRemoteUpdate,
      editingElementId: appState.editingElement?.id,
      sceneVersionNonce: scene.getVersionNonce(),
    };

    // Efficiently clone the store snapshot
    const nextSnapshot = this.snapshot.clone(
      nextElements,
      appState,
      snapshotOptions,
    );

    // Optimisation, don't continue if nothing has changed
    if (this.snapshot !== nextSnapshot) {
      // Calculate and record the changes based on the previous and next snapshot
      if (this.recordingChanges && !this.shouldOnlyUpdateSnapshot) {
        const elementsChange = nextSnapshot.didElementsChange
          ? ElementsChange.calculate(
              this.snapshot.elements,
              nextSnapshot.elements,
            )
          : ElementsChange.empty();

        const appStateChange = nextSnapshot.didAppStateChange
          ? AppStateChange.calculate(
              this.snapshot.appState,
              nextSnapshot.appState,
            )
          : AppStateChange.empty();

        if (!elementsChange.isEmpty() || !appStateChange.isEmpty()) {
          console.log(elementsChange, appStateChange);
          this.onStoreIncrementEmitter.trigger(elementsChange, appStateChange);
        }
      }

      // Update the snapshot
      this.snapshot = nextSnapshot;
    }

    this.recordingChanges = false;
    this.shouldOnlyUpdateSnapshot = false;
    this.isRemoteUpdate = false;
  }

  public clear(): void {
    this.snapshot = Snapshot.empty();
  }

  public destroy(): void {
    this.clear();
    this.onStoreIncrementEmitter.destroy();
  }
}

type CloningOptions = {
  isRemoteUpdate?: boolean;
  editingElementId?: string;
  sceneVersionNonce?: number;
};

class Snapshot {
  public get didElementsChange() {
    return this.options.didElementsChange;
  }

  public get didAppStateChange() {
    return this.options.didElementsChange;
  }

  private constructor(
    public readonly elements: Map<string, ExcalidrawElement>,
    public readonly appState: ReturnType<typeof getObservedAppState>,
    private readonly options: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
      sceneVersionNonce?: number;
    } = { didElementsChange: false, didAppStateChange: false },
  ) {}

  public static empty() {
    return new Snapshot(
      new Map(),
      getObservedAppState(getDefaultAppState() as AppState),
    );
  }

  /**
   * Efficiently clone the existing snapshot.
   *
   * @returns same instance if there are no changes detected, new Snapshot instance otherwise.
   */
  public clone(
    nextElements: Map<string, ExcalidrawElement>,
    nextAppState: AppState,
    options: CloningOptions,
  ) {
    // Not storing everything, just history relevant props
    const nextAppStateSnapshot = getObservedAppState(nextAppState);
    const didElementsChange =
      !!this.options.sceneVersionNonce && // Covers the case when sceneVersionNonce is empty, meaning empty initialized scene, on which we don't want to emit
      this.options.sceneVersionNonce !== options.sceneVersionNonce;

    const didAppStateChange = this.detectChangedAppState(nextAppStateSnapshot);

    // Nothing has changed, so there is no point of continuing further
    if (!didElementsChange && !didAppStateChange) {
      return this;
    }

    // Clone only if there was really a change
    let nextElementsSnapshot = this.elements;
    if (didElementsChange) {
      nextElementsSnapshot = this.createElementsSnapshot(nextElements, options);
    }

    const snapshot = new Snapshot(nextElementsSnapshot, nextAppStateSnapshot, {
      didElementsChange,
      didAppStateChange,
      sceneVersionNonce: options.sceneVersionNonce,
    });

    return snapshot;
  }

  private detectChangedAppState(
    nextAppState: ReturnType<typeof getObservedAppState>,
  ) {
    // TODO: editingLinearElement? other?
    return !isShallowEqual(this.appState, nextAppState, {
      selectedElementIds: isShallowEqual,
      selectedGroupIds: isShallowEqual,
    });
  }

  /**
   * Perform structural clone, cloning only elements that changed.
   */
  private createElementsSnapshot(
    nextElements: Map<string, ExcalidrawElement>,
    options: CloningOptions,
  ) {
    const clonedElements = new Map();

    for (const [id, prevElement] of this.elements.entries()) {
      // clone previous elements, never delete, in case nextElements would be just a subset (i.e. collab)
      clonedElements.set(id, prevElement);
    }

    for (const [id, nextElement] of nextElements.entries()) {
      const prevElement = clonedElements.get(id);

      if (
        !prevElement || // element was added
        (prevElement && prevElement.versionNonce !== nextElement.versionNonce) // element was updated
      ) {
        /**
         * Special case, when we don't want to capture editing element from remote, if it's currently being edited
         * If we would capture it, we would capture yet uncommited element, which would break undo
         * If we would capture it, we would capture yet uncommited element, which would break undo
         */
        if (
          !!options.isRemoteUpdate &&
          nextElement.id === options.editingElementId
        ) {
          continue;
        }

        clonedElements.set(id, deepCopyElement(nextElement));
      }
    }

    return clonedElements;
  }
}
