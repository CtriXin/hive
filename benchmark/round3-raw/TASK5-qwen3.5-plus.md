# Round 3 TASK5 — Translation (中英日三语翻译) 原始答案

## qwen3.5-plus
**耗时: 108556ms**

1. 英文版
In Event-Driven Architecture (EDA), the CQRS pattern separates read and write operations into different models for processing. The Command Side records all state changes via Event Sourcing, while the Query Side maintains a Materialized View to optimize read performance. Eventual Consistency is a core characteristic of this architecture—after write confirmation, the read side may require a latency of milliseconds to seconds to reflect the latest state. Compensating Transactions are used to handle business rollbacks in distributed scenarios.

2. 日文版
イベント駆動アーキテクチャ（EDA）において、CQRS パターンは読み取りおよび書き込み操作を異なるモデルに分離して処理します。コマンドサイドはイベントソーシングを通じてすべての状態変更を記録し、クエリサイドは読み取りパフォーマンスを最適化するためにマテリアライズドビューを維持します。最終整合性はこのアーキテクチャの中核的な特徴です。書き込み確認後、読み取り側が最新の状態を反映するには、数ミリ秒から数秒の遅延が必要な場合があります。補償トランザクションは、分散シナリオにおけるビジネスロールバックを処理するために使用されます。

3. 英文版回译为中文版
在事件驱动架构（EDA）中，CQRS 模式将读写操作分离到不同的模型中进行处理。命令端通过事件溯源记录所有状态变更，而查询端则维护物化视图以优化读取性能。最终一致性是这种架构的核心特征——在写入确认后，读取端可能需要数毫秒到数秒的延迟才能反映最新状态。补偿事务用于处理分布式场景下的业务回滚。
