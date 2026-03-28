# Round 3 TASK5 — Translation (中英日三语翻译) 原始答案

## glm-4.7
**耗时: 6760ms**

1. 英文版
"In Event-Driven Architecture (EDA), the CQRS pattern separates read and write operations into different models. The Command Side records all state changes through Event Sourcing, while the Query Side maintains Materialized Views to optimize read performance. Eventual Consistency is a core characteristic of this architecture—after a write is acknowledged, there may be a delay of milliseconds to seconds before the read side reflects the latest state. Compensating Transactions are used to handle business rollbacks in distributed scenarios."

2. 日文版
"イベント駆動型アーキテクチャ（EDA）において、CQRSパターンは読み取りおよび書き込み操作を異なるモデルに分離して処理します。コマンド側（Command Side）はイベントソーシング（Event Sourcing）を通じてすべての状態変更を記録し、クエリ側（Query Side）は読み取りパフォーマンスを最適化するためにマテリアライズドビュー（Materialized View）を維持します。結果整合性（Eventual Consistency）はこのアーキテクチャの核心的な特徴であり、書き込みが確認された後、読み取り側が最新の状態を反映するまでには数ミリ秒から数秒の遅延が生じる可能性があります。補償トランザクション（Compensating Transaction）は、分散シナリオにおけるビジネスロールバックを処理するために使用されます。"

3. 英文版回译为中文版
"在事件驱动架构（EDA）中，CQRS 模式将读写操作分离到不同的模型中。命令端通过事件溯源记录所有状态变更，而查询端则维护物化视图以优化读取性能。最终一致性是这种架构的一个核心特征——在写入被确认后，读取端可能需要数毫秒到数秒的延迟才能反映最新状态。补偿事务用于处理分布式场景下的业务回滚。"
