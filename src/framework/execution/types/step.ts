import {
  IntegrationExecutionContext,
  IntegrationStepExecutionContext,
} from './context';

export interface IntegrationStepStartState {
  /**
   * Indicates the step is disabled and should not be
   * executed by the state machine.
   */
  disabled: boolean;
}

export type IntegrationStepStartStates = Record<
  string,
  IntegrationStepStartState
>;

export type DetermineStepStartStatesFunction = (
  context: IntegrationExecutionContext,
) => IntegrationStepStartStates;

export enum IntegrationStepResultStatus {
  SUCCESS = 'success',
  FAILURE = 'failure',
  PARTIAL_SUCCESS_DUE_TO_DEPENDENCY_FAILURE = 'partial_success_due_to_dependency_failure',
  SKIPPED = 'skipped',
  NOT_EXECUTED = 'not_executed',
}

export type IntegrationStep = IntegrationStepMetadata & {
  /**
   * Function that runs to perform the stpe that
   */
  executionHandler: (
    context: IntegrationStepExecutionContext,
  ) => Promise<void> | void;
};

export type IntegrationStepResult = IntegrationStepMetadata & {
  status: IntegrationStepResultStatus;
};

interface IntegrationStepMetadata {
  /*
   * Identifier used to reference and track steps
   */
  id: string;

  /**
   * Friendly name that will be displayed in debug logs
   * and to customers in the job event log.
   */
  name: string;

  /**
   * Entity or relationship types that are expected to be
   * generated by this step
   */
  types: string[];

  /**
   * An optional array of other step ids that need to execute
   * before the current step can.
   */
  dependsOn?: string[];
}
