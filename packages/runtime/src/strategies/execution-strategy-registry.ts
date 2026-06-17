import { PlusOneError } from '@plus-one/contracts';

export interface ExecutionStrategy {
  name: string;
  parallel: boolean;
  requiresCheckedReconciliation: boolean;
  description: string;
}

const REQUIRED_STRATEGIES: readonly ExecutionStrategy[] = [
  { name: 'verified-factual-lookup', parallel: false, requiresCheckedReconciliation: false,
    description: 'Single work cell that returns one checked factual answer.' },
  { name: 'single-maker-checker', parallel: false, requiresCheckedReconciliation: false,
    description: 'Sequential maker-checker work cells for non-parallel work.' },
  { name: 'parallel-independent-makers', parallel: true, requiresCheckedReconciliation: false,
    description: 'Independent maker-checker work cells that may run concurrently.' },
  { name: 'adversarial-analysis-reconciliation', parallel: true, requiresCheckedReconciliation: true,
    description: 'Parallel adversarial work cells whose results are reconciled by a checked work cell.' },
];

export class ExecutionStrategyRegistry {
  private readonly strategies = new Map<string, ExecutionStrategy>();

  constructor(initial: readonly ExecutionStrategy[] = []) {
    for (const strategy of initial) {
      if (this.strategies.has(strategy.name)) {
        throw new PlusOneError({ category: 'policy_rejected', code: 'duplicate_execution_strategy',
          message: 'Execution strategy is already registered', retry: 'never',
          receiptLookupRequired: false, details: { name: strategy.name } });
      }
      this.strategies.set(strategy.name, Object.freeze({ ...strategy }));
    }
  }

  static withRequiredStrategies(): ExecutionStrategyRegistry {
    return new ExecutionStrategyRegistry(REQUIRED_STRATEGIES);
  }

  resolve(name: string): ExecutionStrategy {
    const strategy = this.strategies.get(name);
    if (strategy === undefined) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'execution_strategy_not_registered',
        message: 'Execution strategy is not registered', retry: 'never',
        receiptLookupRequired: false, details: { name } });
    }
    return strategy;
  }

  list(): readonly ExecutionStrategy[] {
    return Object.freeze([...this.strategies.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  assertAllowed(name: string, allowedNames: readonly string[], workCount: number): ExecutionStrategy {
    const strategy = this.resolve(name);
    if (!allowedNames.includes(name)) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'execution_strategy_not_allowed',
        message: 'Execution strategy is not allowed for this team', retry: 'never',
        receiptLookupRequired: false, details: { name, allowedNames: allowedNames.join(',') } });
    }
    if (strategy.parallel && workCount < 2) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'parallel_strategy_requires_multiple_work',
        message: 'Parallel execution strategies require at least two work cells', retry: 'never',
        receiptLookupRequired: false, details: { name, workCount } });
    }
    if (!strategy.parallel && workCount !== 1) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'single_strategy_requires_one_work',
        message: 'Single work-cell strategies require exactly one work cell', retry: 'never',
        receiptLookupRequired: false, details: { name, workCount } });
    }
    return strategy;
  }
}
