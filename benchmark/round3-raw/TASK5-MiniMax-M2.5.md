# Round 3 TASK5 — Translation (中英日三语翻译) 原始答案

## MiniMax-M2.5
**耗时: 8509ms**

1. 英文版
"In Event-Driven Architecture (EDA), the CQRS pattern separates read and write operations into different models. The Command Side records all state changes through Event Sourcing, while the Query Side maintains Materialized Views to optimize read performance. Eventual Consistency is the core characteristic of this architecture—after write confirmation, the read side may require a delay from milliseconds to seconds to reflect the latest state. Compensating Transactions are used to handle business rollbacks in distributed scenarios."

2. 日文版
「イベント駆動アーキテクチャ（EDA）において、CQRSパターンは読み取りと書き込み操作を異なるモデルに分離します。コマンドサイドはイベントソーシングを通じてすべての状態変更を記録し、クエリサイドはマテリアライズドビューを維持して読み取りパフォーマンスを最適化します。最終整合性はこのアーキテクチャの中核的な特性です。書き込み確認後、読み取りサイドは最新状態を反映するためにミリ秒から数秒の遅延が必要となる場合があります。補償トランザクションは分散シナリオでのビジネスロールバックを処理するために使用されます。」

3. 英文版回译为中文版
"在事件驱动架构（EDA）中，CQRS模式将读取和写入操作分离到不同的模型中。命令端通过事件溯源记录所有状态变更，而查询端则维护物化视图以优化读取性能。最终一致性是这种架构的核心特性——写入确认后，读取端可能需要从毫秒到数秒的延迟才能反映最新状态。补偿事务用于处理分布式场景中的业务回滚。"
