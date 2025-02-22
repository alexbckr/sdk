import { DepGraph } from 'dependency-graph';
import PromiseQueue from 'p-queue';

import {
  BeforeAddEntityHookFunction,
  Entity,
  ExecutionContext,
  IntegrationStepResult,
  Step,
  StepExecutionContext,
  StepResultStatus,
  StepStartStates,
} from '@jupiterone/integration-sdk-core';

import { timeOperation } from '../metrics';
import { GraphObjectStore } from '../storage';
import {
  createStepJobState,
  DuplicateKeyTracker,
  MemoryDataStore,
  TypeTracker,
} from './jobState';
import {
  CreateStepGraphObjectDataUploaderFunction,
  StepGraphObjectDataUploader,
} from './uploader';
import {
  iterateParsedEntityGraphFiles,
  iterateParsedRelationshipGraphFiles,
} from '../fileSystem';

/**
 * This function accepts a list of steps and constructs a dependency graph
 * using the `dependsOn` field from each step.
 */
export function buildStepDependencyGraph<
  TStepExecutionContext extends StepExecutionContext,
>(steps: Step<TStepExecutionContext>[]): DepGraph<Step<TStepExecutionContext>> {
  const dependencyGraph = new DepGraph<Step<TStepExecutionContext>>();

  // add all nodes first
  steps.forEach((step) => {
    dependencyGraph.addNode(step.id, step);
  });

  // add dependencies
  steps.forEach((step) => {
    step.dependsOn?.forEach((dependency) => {
      dependencyGraph.addDependency(step.id, dependency);
    });
  });

  // executing overallOrder will throw an error
  // if a circular dependency is found
  dependencyGraph.overallOrder();

  return dependencyGraph;
}

/**
 * This function takes a step dependency graph and executes
 * the steps in order based on the values of their `dependsOn`.
 *
 * How execution works:
 *
 * First, all leaf nodes are executed.
 *
 * After each node's work completes, the node is removed from
 * the dependency graph. After the node is removed,
 * the graph checks to see if the removal of the node has
 * created more leaf nodes and executes them. This continues
 * until there are no more nodes to execute.
 */
export function executeStepDependencyGraph<
  TExecutionContext extends ExecutionContext,
  TStepExecutionContext extends StepExecutionContext,
>({
  executionContext,
  inputGraph,
  stepStartStates,
  duplicateKeyTracker,
  graphObjectStore,
  dataStore,
  createStepGraphObjectDataUploader,
  beforeAddEntity,
}: {
  executionContext: TExecutionContext;
  inputGraph: DepGraph<Step<TStepExecutionContext>>;
  stepStartStates: StepStartStates;
  duplicateKeyTracker: DuplicateKeyTracker;
  graphObjectStore: GraphObjectStore;
  dataStore: MemoryDataStore;
  createStepGraphObjectDataUploader?: CreateStepGraphObjectDataUploaderFunction;
  beforeAddEntity?: BeforeAddEntityHookFunction<TExecutionContext>;
}): Promise<IntegrationStepResult[]> {
  // create a clone of the dependencyGraph because mutating
  // the input graph is icky
  //
  // cloned graph is mutated because it is slightly easier to
  // remove nodes from the graph to find new leaf nodes
  // instead of tracking state ourselves
  const workingGraph = inputGraph.clone();

  // create a queue for managing promises to be executed
  const promiseQueue = new PromiseQueue();

  const typeTracker = new TypeTracker();
  const stepResultsMap = buildStepResultsMap(inputGraph, stepStartStates);

  function isStepEnabled(stepId: string) {
    return stepStartStates[stepId].disabled === false;
  }

  function hasCachePath(stepId: string) {
    return !!stepStartStates[stepId].stepCachePath ?? false;
  }

  /**
   * Updates the result of a step result with the provided satus
   */
  function updateStepResultStatus(
    stepId: string,
    status: StepResultStatus,
    typeTracker: TypeTracker,
  ) {
    const existingResult = stepResultsMap.get(stepId);
    if (existingResult) {
      stepResultsMap.set(stepId, {
        ...existingResult,
        status,
        encounteredTypes: typeTracker.getEncounteredTypesForStep(stepId),
      });
    }
  }

  /**
   * Finds a result from the dependency graph that contains
   * a status of FAILURE or PARTIAL_SUCCESS_DUE_TO_DEPENDENCY_FAILURE.
   *
   * NOTE: the untouched input graph is used for determining
   * results since the working graph gets mutated.
   */
  function stepHasDependencyFailure(stepId: string) {
    return inputGraph
      .dependenciesOf(stepId)
      .map((id) => stepResultsMap.get(id))
      .find((result) => {
        const status = result?.status;
        return (
          status === StepResultStatus.FAILURE ||
          status === StepResultStatus.PARTIAL_SUCCESS_DUE_TO_DEPENDENCY_FAILURE
        );
      });
  }

  /**
   * Safely removes a step from the workingGraph, ensuring
   * that dependencys are removed.
   *
   * This function helps create new leaf nodes to execute.
   */
  function removeStepFromWorkingGraph(stepId: string) {
    workingGraph.dependantsOf(stepId).forEach((dependent) => {
      workingGraph.removeDependency(dependent, stepId);
    });

    workingGraph.removeNode(stepId);
  }

  /**
   * This function checks if a step's dependencies are complete
   */
  function stepDependenciesAreComplete(stepId: string) {
    const executingDependencies = inputGraph
      .dependenciesOf(stepId)
      .map((id) => stepResultsMap.get(id))
      .filter(
        (stepResult) =>
          stepResult?.status === StepResultStatus.PENDING_EVALUATION,
      );

    return executingDependencies.length === 0;
  }

  /**
   * Logs undeclaredTypes if any are found.
   */
  function maybeLogUndeclaredTypes(
    context: TStepExecutionContext,
    step: Step<TStepExecutionContext>,
    typeTracker: TypeTracker,
  ) {
    const encounteredTypes = typeTracker.getEncounteredTypesForStep(step.id);
    const declaredTypesSet = new Set(
      getDeclaredTypesInStep(step).declaredTypes,
    );
    const undeclaredTypes = encounteredTypes.filter(
      (type) => !declaredTypesSet.has(type),
    );

    if (undeclaredTypes.length) {
      context.logger.warn(
        {
          undeclaredTypes,
        },
        'Undeclared types were detected.',
      );
    }
  }

  return new Promise((resolve, reject) => {
    /**
     * If an unexpected error occurs during the execution of a step,
     * this function catch that, pause the queue so that
     * additional work is not executed and reject the promise.
     */
    function handleUnexpectedError(err: Error) {
      promiseQueue.pause();
      reject(err);
    }

    /**
     * This function finds leaf steps that can be executed
     * and adds the step execution to the promise queue.
     *
     * As prior to enqueuing the work, step is removed from the
     * working graph.
     */
    function enqueueLeafSteps() {
      // do not add more work if promise queue has been paused.
      if (promiseQueue.isPaused) {
        return;
      }

      workingGraph.overallOrder(true).forEach((stepId) => {
        const step = workingGraph.getNodeData(stepId);

        /**
         * We only remove the node from the graph and
         * execute the step if it is enabled. If a cache filepath
         * is provided, the execution is replaced with loading
         * from disk.
         *
         * This allows for dependencies to remain in the graph
         * and prevents dependent steps from executing.
         */
        if (isStepEnabled(stepId) && stepDependenciesAreComplete(stepId)) {
          removeStepFromWorkingGraph(stepId);
          void promiseQueue.add(() =>
            timeOperation({
              logger: executionContext.logger,
              metricName: `duration-step`,
              dimensions: {
                stepId,
                cached: hasCachePath(stepId).toString(),
              },
              operation: () => executeStep(step),
            }).catch(handleUnexpectedError),
          );
        }
      });
    }

    /**
     * This function runs a step's executionHandler.
     *
     * Errors from an execution handler are caught and used to
     * determine a status code for the step's result.
     */
    async function executeStep(step: Step<TStepExecutionContext>) {
      const { id: stepId } = step;

      let uploader: StepGraphObjectDataUploader | undefined;

      if (createStepGraphObjectDataUploader) {
        uploader = createStepGraphObjectDataUploader(stepId);
      }

      const context = buildStepContext<
        TExecutionContext,
        TStepExecutionContext
      >({
        context: executionContext,
        duplicateKeyTracker,
        typeTracker,
        graphObjectStore,
        dataStore,
        stepId,
        beforeAddEntity,
        uploader,
      });

      const { logger } = context;

      logger.stepStart(step);

      let status: StepResultStatus | undefined;

      try {
        if (hasCachePath(stepId)) {
          const stepCacheFilePath = stepStartStates[step.id].stepCachePath!;
          status = await loadCacheForStep(stepCacheFilePath, context);
        }

        if (status !== StepResultStatus.CACHED) {
          await step.executionHandler(context);

          if (stepHasDependencyFailure(stepId)) {
            status = StepResultStatus.PARTIAL_SUCCESS_DUE_TO_DEPENDENCY_FAILURE;
          } else {
            status = StepResultStatus.SUCCESS;
            maybeLogUndeclaredTypes(context, step, typeTracker);
          }
        }
        context.logger.stepSuccess(step);

        logger.info(
          {
            stepId,
            summary: JSON.stringify(typeTracker.summarizeStep(stepId)),
          },
          'Step summary',
        );
      } catch (err) {
        logger.info(
          {
            stepId,
            summary: JSON.stringify(typeTracker.summarizeStep(stepId)),
          },
          'Failed step summary',
        );

        context.logger.stepFailure(step, err);

        if (err.fatal) {
          // rethrow the error to stop dependency graph execution
          throw err;
        }

        status = StepResultStatus.FAILURE;
      }

      await context.jobState.flush();

      if (context.jobState.waitUntilUploadsComplete) {
        try {
          // Failing to upload all integration data should not be considered a
          // fatal failure. We just want to make this step as a partial success
          // and move on with our lives!
          await context.jobState.waitUntilUploadsComplete();
        } catch (err) {
          context.logger.stepFailure(step, err);
          status = StepResultStatus.FAILURE;
        }
      }

      updateStepResultStatus(stepId, status, typeTracker);
      enqueueLeafSteps();
    }

    /**
     * Loads cached step data.
     * @param stepCacheFilePath
     * @param context
     */
    async function loadCacheForStep(
      stepCacheFilePath: string,
      context: TStepExecutionContext,
    ) {
      let status = StepResultStatus.FAILURE;
      const entitiesPath = `${stepCacheFilePath}/entities`;
      const relationshipsPath = `${stepCacheFilePath}/relationships`;

      const { jobState, logger } = context;

      let entitiesCount = 0;
      await iterateParsedEntityGraphFiles(async (entities) => {
        entitiesCount += entities.length;
        await jobState.addEntities(entities);
        status = StepResultStatus.CACHED;
      }, entitiesPath);

      let relationshipCount = 0;
      await iterateParsedRelationshipGraphFiles(async (relationships) => {
        relationshipCount += relationships.length;
        await jobState.addRelationships(relationships);
        status = StepResultStatus.CACHED;
      }, relationshipsPath);

      if (entitiesCount || relationshipCount) {
        logger.info(
          { entitiesCount, relationshipCount },
          `Loaded entities and relationship(s) from cache.`,
        );
      } else {
        logger.warn(
          `Expected to find entities or relationships for step but found none.`,
        );
      }

      return status;
    }

    // kick off work for all leaf nodes
    enqueueLeafSteps();

    void promiseQueue
      .onIdle()
      .then(() => resolve([...stepResultsMap.values()]))
      .catch(reject);
  });
}

function buildStepContext<
  TExecutionContext extends ExecutionContext,
  TStepExecutionContext extends StepExecutionContext,
>({
  stepId,
  context,
  duplicateKeyTracker,
  typeTracker,
  graphObjectStore,
  dataStore,
  uploader,
  beforeAddEntity,
}: {
  stepId: string;
  context: TExecutionContext;
  duplicateKeyTracker: DuplicateKeyTracker;
  typeTracker: TypeTracker;
  graphObjectStore: GraphObjectStore;
  dataStore: MemoryDataStore;
  uploader?: StepGraphObjectDataUploader;
  beforeAddEntity?: BeforeAddEntityHookFunction<TExecutionContext>;
}): TStepExecutionContext {
  // Purposely assigned to `undefined` instead of a noop function even though
  // this code is a bit messier. The jobState code is fairly hot and checking
  // for a falsy `beforeAddEntity` is faster than invoking a noop function for
  // every entity.
  const jobStateBeforeAddEntity =
    typeof beforeAddEntity !== 'undefined'
      ? (entity: Entity): Entity => {
          return beforeAddEntity(context, entity);
        }
      : undefined;

  const jobState = createStepJobState({
    stepId,
    duplicateKeyTracker,
    typeTracker,
    graphObjectStore,
    dataStore,
    beforeAddEntity: jobStateBeforeAddEntity,
    uploader,
  });

  const stepExecutionContext: StepExecutionContext = {
    ...context,
    logger: context.logger.child({
      stepId,
    }),
    jobState,
  };

  return stepExecutionContext as TStepExecutionContext;
}

function buildStepResultsMap<
  TStepExecutionContext extends StepExecutionContext,
>(
  dependencyGraph: DepGraph<Step<TStepExecutionContext>>,
  stepStartStates: StepStartStates,
) {
  const stepResultMapEntries = dependencyGraph
    .overallOrder()
    .map((stepId): IntegrationStepResult => {
      const step = dependencyGraph.getNodeData(stepId);

      const hasDisabledDependencies =
        dependencyGraph
          .dependenciesOf(step.id)
          .filter((id) => stepStartStates[id].disabled).length > 0;

      const { declaredTypes, partialTypes } = getDeclaredTypesInStep(step);

      return {
        id: step.id,
        name: step.name,
        dependsOn: step.dependsOn,
        declaredTypes,
        partialTypes,
        encounteredTypes: [],
        status:
          stepStartStates[step.id].disabled || hasDisabledDependencies
            ? StepResultStatus.DISABLED
            : StepResultStatus.PENDING_EVALUATION,
      };
    })
    .map((result): [string, IntegrationStepResult] => [result.id, result]);

  return new Map<string, IntegrationStepResult>(stepResultMapEntries);
}

export function getDeclaredTypesInStep<
  TStepExecutionContext extends StepExecutionContext,
>(
  step: Step<TStepExecutionContext>,
): {
  declaredTypes: string[];
  partialTypes: string[];
} {
  const declaredTypes: string[] = [];
  const partialTypes: string[] = [];

  [
    ...step.entities,
    ...step.relationships,
    ...(step.mappedRelationships || []),
  ].map((e) => {
    declaredTypes.push(e._type);
    if (e.partial) {
      partialTypes.push(e._type);
    }
  });

  return { declaredTypes, partialTypes };
}
